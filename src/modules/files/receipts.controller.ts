import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { ValidationError, UnsupportedMediaTypeError } from "../../core/errors.ts";
import type { ReceiptsPort } from "./receipts.service.ts";

// 영수증 허용 타입 — 임의 타입 저장·inline 서빙 시 stored XSS(HTML/SVG). 이미지·PDF만.
const RECEIPT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

interface Deps {
  service: ReceiptsPort;
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  maxBytes?: number;
}

const DEFAULT_MAX = 10 * 1024 * 1024; // 10MB

/** 영수증 프록시 라우트(plain — 바이너리 바디는 zod-openapi 부적합). trip 멤버 인가·rate limit은 상위 미들웨어. */
export function registerReceiptRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);
  const max = deps.maxBytes ?? DEFAULT_MAX;

  app.post("/trips/:tripId/expenses/:expenseId/receipt", auth, member, async (c) => {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!RECEIPT_TYPES.has(ct))
      throw new UnsupportedMediaTypeError("unsupported receipt type", {
        allowed: [...RECEIPT_TYPES],
      });
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength === 0) throw new ValidationError("empty receipt body");
    if (buf.byteLength > max) throw new ValidationError("receipt too large", { max });
    const { objectKey } = await deps.service.attach(
      c.req.param("tripId")!,
      c.req.param("expenseId")!,
      new Uint8Array(buf),
      ct,
    );
    return c.json({ objectKey }, 201);
  });

  app.get("/trips/:tripId/expenses/:expenseId/receipt", auth, member, async (c) => {
    const obj = await deps.service.get(c.req.param("tripId")!, c.req.param("expenseId")!);
    // 하드닝: 절대 inline 렌더 안 함(attachment) + sniff 차단 + CSP sandbox(stored XSS 방어)
    return c.body(obj.bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": obj.contentType,
      "Content-Disposition": 'attachment; filename="receipt"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });

  app.delete("/trips/:tripId/expenses/:expenseId/receipt", auth, member, async (c) => {
    await deps.service.remove(c.req.param("tripId")!, c.req.param("expenseId")!);
    return c.body(null, 204);
  });
}
