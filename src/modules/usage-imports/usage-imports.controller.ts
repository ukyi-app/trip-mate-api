import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { UnavailableError } from "../../core/errors.ts";
import { requireAuth, requireTripMember } from "../../core/guards.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { usageParseRequestSchema, usageParseResponseSchema } from "./usage-imports.schema.ts";
import type { UsageParserPort } from "./usage-parser.port.ts";

interface Deps {
  parser?: UsageParserPort; // 미설정(graceful off) 시 503 — 라우트는 항상 등록(스펙-런타임 일치)
  resolver: SessionResolver;
  memberLookup: MembershipLookup;
  now?: () => Date; // 테스트 결정성 — reference_date 기본값(서버 오늘)
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});
const jsonBody = <S extends z.ZodTypeAny>(schema: S) => ({
  content: { "application/json": { schema } },
  required: true,
});

// 카드 SMS 타임스탬프는 KST — 기준일 기본값도 KST 날짜로(UTC 자정 경계에 하루 밀림 방지).
const KST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD

/** 사용내역 텍스트 → 지출 초안(무상태, 저장 없음 — preview 선례: 멱등 불필요). */
export function registerUsageImportRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);
  const member = requireTripMember(deps.memberLookup);

  app.openapi(
    createRoute({
      method: "post",
      path: "/trips/{tripId}/usage-imports/parse",
      security: [{ cookieAuth: [] }],
      middleware: [auth, member],
      request: {
        params: z.object({ tripId: z.string().uuid() }),
        body: jsonBody(usageParseRequestSchema),
      },
      responses: { ...ok(usageParseResponseSchema), ...errorResponses(403, 422, 502, 503) },
    }),
    async (c) => {
      if (!deps.parser) throw new UnavailableError("usage parsing not configured");
      const { text, reference_date } = c.req.valid("json");
      const referenceDate = reference_date ?? KST_DATE.format(deps.now?.() ?? new Date());
      const drafts = await deps.parser.parse({ text, referenceDate });
      return c.json({ drafts }, 200);
    },
  );
}
