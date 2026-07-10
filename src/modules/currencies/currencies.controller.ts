import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth, type SessionResolver } from "../../core/guards.ts";
import { errorResponses } from "../../core/http.ts";
import { currencyResponseSchema } from "./currencies.schema.ts";
import type { CurrenciesService } from "./currencies.service.ts";

interface Deps {
  service: CurrenciesService;
  resolver: SessionResolver;
}

const ok = <S extends z.ZodTypeAny>(schema: S) => ({
  200: { description: "ok", content: { "application/json": { schema } } },
});

/** 통화 참조 데이터 라우트 — 인증만(정적 참조 데이터라 trip 스코핑 없음, NO requireTripMember).
 *  minor_unit SSOT를 노출해 FE가 local_amount 표시/입력을 결정한다. */
export function registerCurrencyRoutes(app: OpenAPIHono, deps: Deps): void {
  const auth = requireAuth(deps.resolver);

  app.openapi(
    createRoute({
      method: "get",
      path: "/currencies",
      security: [{ cookieAuth: [] }],
      middleware: [auth], // 인증만 — 정적 참조 데이터(trip 비종속)
      responses: { ...ok(z.array(currencyResponseSchema)), ...errorResponses(403) },
    }),
    async (c) => {
      const list = await deps.service.list();
      c.header("Cache-Control", "private, max-age=3600"); // auth-gated → private(공유/CDN 캐시가 미인증에 200 서빙 방지), per-session 캐시만
      return c.json(list, 200);
    },
  );
}
