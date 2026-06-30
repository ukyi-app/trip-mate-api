import type { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createApp, registerSecurity } from "./core/openapi.ts";
import { csrf } from "./core/csrf.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { registerTripRoutes } from "./modules/trips/trips.controller.ts";
import { registerMemberRoutes } from "./modules/members/members.controller.ts";
import { registerExpenseRoutes } from "./modules/expenses/expenses.controller.ts";
import { registerSettlementRoutes } from "./modules/settlements/settlements.controller.ts";
import type { TripsService } from "./modules/trips/trips.service.ts";
import type { MembersService } from "./modules/members/members.service.ts";
import type { ExpensesService } from "./modules/expenses/expenses.service.ts";
import type { SettlementsService } from "./modules/settlements/settlements.service.ts";
import type { TripDefaultsPort } from "./modules/fx/fx.types.ts";
import type { IdempotencyStore } from "./core/idempotency.ts";
import type { SessionResolver, MembershipLookup } from "./core/guards.ts";

export interface V1Deps {
  tripsService: TripsService<Record<string, unknown>>;
  membersService: MembersService;
  expensesService: ExpensesService<Record<string, unknown>>;
  settlementsService: SettlementsService<Record<string, unknown>>;
  tripDefaults: TripDefaultsPort;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  memberLookup: MembershipLookup;
  idempotencyStore: IdempotencyStore | null;
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
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], // PUT=fx-defaults(finding #1 pass2)
      allowHeaders: ["Content-Type", "Idempotency-Key"], // Idempotency-Key preflight 허용(finding #5 pass1)
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
  registerExpenseRoutes(v1, {
    expensesService: deps.expensesService,
    resolver: deps.resolver,
    memberLookup: deps.memberLookup,
    idempotencyStore: deps.idempotencyStore,
    tripDefaults: deps.tripDefaults,
  });
  registerSettlementRoutes(v1, {
    settlementsService: deps.settlementsService,
    resolver: deps.resolver,
    memberLookup: deps.memberLookup,
    idempotencyStore: deps.idempotencyStore,
  });
  return v1;
}
