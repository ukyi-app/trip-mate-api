import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
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
import type { Mailer } from "./modules/notifications/mailer.port.ts";
import type { ReceiptsPort } from "./modules/files/receipts.service.ts";
import { registerReceiptRoutes } from "./modules/files/receipts.controller.ts";
import type { UsageParserPort } from "./modules/usage-imports/usage-parser.port.ts";
import { registerUsageImportRoutes } from "./modules/usage-imports/usage-imports.controller.ts";

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
  rateLimit?: MiddlewareHandler; // 쓰기 rate limit(main에서 Redis 바인딩 주입, 없으면 미적용)
  mailer?: Mailer; // 초대 이메일 발송(없으면 skip). inviteBaseUrl은 webOrigins[0] 파생.
  receipts?: ReceiptsPort; // 영수증 프록시(files 서버, 없으면 라우트 미등록)
  usageParser?: UsageParserPort; // 사용내역 파싱 LLM(없으면 parse 라우트 503 — 라우트는 항상 등록)
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
  if (deps.rateLimit) v1.use("*", deps.rateLimit); // 라우트 전 rate limit(csrf보다 앞 — 거부 요청도 카운트)
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
    ...(deps.mailer ? { mailer: deps.mailer, inviteBaseUrl: deps.webOrigins[0] ?? "" } : {}),
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
  if (deps.receipts)
    registerReceiptRoutes(v1, {
      service: deps.receipts,
      resolver: deps.resolver,
      memberLookup: deps.memberLookup,
    });
  // 사용내역 파싱 — parser 미주입이어도 등록(503로 명시적 off 신호, 스펙-런타임 일치).
  registerUsageImportRoutes(v1, {
    resolver: deps.resolver,
    memberLookup: deps.memberLookup,
    ...(deps.usageParser ? { parser: deps.usageParser } : {}),
  });
  // 계약 자체 서빙(homelab self-host) — 앱이 OpenAPI 스펙을 /v1/openapi.json 으로 노출.
  // plain route(스펙 미포함)·GET(CSRF bypass)·인증 없음. 1회 생성 후 캐시(gen:openapi와 동일 구성).
  let cachedDoc: ReturnType<typeof v1.getOpenAPI31Document> | undefined;
  v1.get("/openapi.json", (c) =>
    c.json(
      (cachedDoc ??= v1.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "trip-mate API", version: "1.0.0" },
      })),
    ),
  );
  return v1;
}
