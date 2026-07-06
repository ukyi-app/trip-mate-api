import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  requireAuth,
  requireTripMember,
  type SessionResolver,
  type MembershipLookup,
} from "../../core/guards.ts";
import { ValidationError } from "../../core/errors.ts";
import type { ReceiptsPort } from "./receipts.service.ts";

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
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength === 0) throw new ValidationError("empty receipt body");
    if (buf.byteLength > max) throw new ValidationError("receipt too large", { max });
    const ct = c.req.header("content-type") ?? "application/octet-stream";
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
    return c.body(obj.bytes as unknown as ArrayBuffer, 200, { "Content-Type": obj.contentType });
  });

  app.delete("/trips/:tripId/expenses/:expenseId/receipt", auth, member, async (c) => {
    await deps.service.remove(c.req.param("tripId")!, c.req.param("expenseId")!);
    return c.body(null, 204);
  });
}
