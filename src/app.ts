import type { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createApp, registerSecurity } from "./core/openapi.ts";
import { csrf } from "./core/csrf.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { registerTripRoutes } from "./modules/trips/trips.controller.ts";
import { registerMemberRoutes } from "./modules/members/members.controller.ts";
import type { TripsService } from "./modules/trips/trips.service.ts";
import type { MembersService } from "./modules/members/members.service.ts";
import type { SessionResolver, MembershipLookup } from "./core/guards.ts";

export interface V1Deps {
  tripsService: TripsService<Record<string, unknown>>;
  membersService: MembersService;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
  webOrigins: string[];
}

/** /v1 라우트·security·미들웨어(CORS→CSRF→라우트)를 등록한 OpenAPIHono 반환.
 *  main(실 deps)·gen:openapi(stub deps, 핸들러 미실행 시 무-IO) 공용. basePath는 OpenAPIHono 보존(런타임 확인). */
export function buildV1App(deps: V1Deps): OpenAPIHono {
  const v1 = createApp().basePath("/v1") as unknown as OpenAPIHono;
  registerSecurity(v1);
  registerErrorFilter(v1);
  v1.use(
    "*",
    cors({
      origin: deps.webOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );
  v1.use("*", csrf(deps.webOrigins)); // 안전 메서드 bypass·정확 Origin
  registerTripRoutes(v1, {
    tripsService: deps.tripsService,
    resolver: deps.resolver,
    emailOf: deps.emailOf,
    memberLookup: deps.memberLookup,
  });
  registerMemberRoutes(v1, {
    service: deps.membersService,
    resolver: deps.resolver,
    emailOf: deps.emailOf,
    memberLookup: deps.memberLookup,
  });
  return v1;
}
