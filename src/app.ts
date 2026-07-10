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
import type { ParserQuota } from "./modules/usage-imports/parser-quota.ts";
import type { UsageMetrics } from "./core/metrics.ts";
import {
  registerUsageImportRoutes,
  type TripContext,
} from "./modules/usage-imports/usage-imports.controller.ts";
import { registerExpenseDraftRoutes } from "./modules/expense-drafts/expense-drafts.controller.ts";
import {
  toDraftResponse,
  type ExpenseDraftsService,
} from "./modules/expense-drafts/expense-drafts.service.ts";
import { registerConsentRoutes } from "./modules/consents/consents.controller.ts";
import type { ConsentService } from "./modules/consents/consents.service.ts";
import { registerCurrencyRoutes } from "./modules/currencies/currencies.controller.ts";
import type { CurrenciesService } from "./modules/currencies/currencies.service.ts";

export interface V1Deps {
  tripsService: TripsService<Record<string, unknown>>;
  membersService: MembersService;
  expensesService: ExpensesService<Record<string, unknown>>;
  settlementsService: SettlementsService<Record<string, unknown>>;
  tripDefaults: TripDefaultsPort;
  resolver: SessionResolver;
  emailOf: (userId: string) => Promise<string>;
  nameOf: (userId: string) => Promise<string>; // Google 계정 이름(trip 어드민 표시 이름 폴백)
  memberLookup: MembershipLookup;
  idempotencyStore: IdempotencyStore | null;
  webOrigins: string[];
  rateLimit?: MiddlewareHandler; // 쓰기 rate limit(main에서 Redis 바인딩 주입, 없으면 미적용)
  mailer?: Mailer; // 초대 이메일 발송(없으면 skip). inviteBaseUrl은 webOrigins[0] 파생.
  receipts?: ReceiptsPort; // 영수증 프록시(files 서버, 없으면 라우트 미등록)
  usageParser?: UsageParserPort; // 사용내역 파싱 LLM(없으면 parse 라우트 503 — 라우트는 항상 등록)
  tripContext?: TripContext; // 사용내역 날짜 보정용 여행 timezone·기간 조회(없으면 KST 폴백)
  usageQuota?: ParserQuota; // parse 전용 per-user·per-trip 쿼터(check+refund)
  usageMetrics?: UsageMetrics; // 파싱 메트릭 registry
  expenseDrafts: ExpenseDraftsService; // 지속형 초안(parse 저장·조회·편집·확정·폐기). 항상 배선(라우트 무조건 등록)
  consentService: ConsentService; // 서버측 동의 기록(PB-1). 항상 배선 — parse recordDisclosure를 필수화(fail-closed)
  currenciesService: CurrenciesService; // 통화 참조 데이터(minor_unit SSOT). 항상 배선 — 라우트 무조건 등록(스펙 항상 포함)
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
      exposeHeaders: ["Retry-After"], // 429/503 백오프 값을 브라우저 클라가 읽을 수 있게(비-safelisted)
    }),
  );
  if (deps.rateLimit) v1.use("*", deps.rateLimit); // 라우트 전 rate limit(csrf보다 앞 — 거부 요청도 카운트)
  v1.use("*", csrf(deps.webOrigins)); // 안전 메서드 bypass·정확 Origin
  registerTripRoutes(v1, {
    tripsService: deps.tripsService,
    resolver: deps.resolver,
    emailOf: deps.emailOf,
    nameOf: deps.nameOf,
    memberLookup: deps.memberLookup,
    // net PORT: 이미 배선된 settlementsService에서 파생(V1Deps 불변). 목록 net을 배치 계산.
    netLookup: (pairs) => deps.settlementsService.netsForMemberships(pairs),
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
  // 지속형 초안 — 라우트 무조건 등록(스펙-런타임 일치: openapi.json에 항상 포함). 서비스는 항상 배선.
  const drafts = deps.expenseDrafts;
  registerExpenseDraftRoutes(v1, {
    service: drafts,
    resolver: deps.resolver,
    memberLookup: deps.memberLookup,
  });
  // 서버측 동의 기록(PB-1) — 항상 등록. parse의 llm_disclosure fail-closed 기록을 위해 서비스도 항상 배선.
  registerConsentRoutes(v1, { service: deps.consentService, resolver: deps.resolver });
  // 통화 참조 데이터(minor_unit SSOT) — 항상 등록(정적, 인증만, trip 비종속). openapi.json에 항상 포함.
  registerCurrencyRoutes(v1, { service: deps.currenciesService, resolver: deps.resolver });
  // 사용내역 파싱 — parser 미주입이어도 등록(503로 명시적 off 신호, 스펙-런타임 일치).
  registerUsageImportRoutes(v1, {
    resolver: deps.resolver,
    memberLookup: deps.memberLookup,
    // PB-1: LLM 전송 전 llm_disclosure fail-closed 기록(필수 dep — 항상 배선된 consentService에서).
    recordDisclosure: (userId, opts) => deps.consentService.recordDisclosure(userId, opts),
    // 초안 지속: 저장 후 id 포함 반환(FE가 검토/편집/confirm에 사용). opts=importKey(크래시-갭 replay)·sourceObjectKey(이미지).
    persistDrafts: async (tripId, memberId, list, source, opts) =>
      (await drafts.saveDrafts(tripId, memberId, list, source, opts ?? {})).map(toDraftResponse),
    // parse가 저장을 하므로 Idempotency-Key 재시도 dedup 적용(중복 초안 방지) — 지출 create와 동일 store.
    ...(deps.idempotencyStore ? { idempotencyStore: deps.idempotencyStore } : {}),
    ...(deps.tripContext ? { tripContext: deps.tripContext } : {}), // 여행 timezone·기간 날짜 보정
    // 쿼터는 parser 있을 때만 — 미설정(503) 상태에서 쿼터를 소모하면 복구 후에도 429로 막힐 수 있음(리뷰).
    ...(deps.usageParser && deps.usageQuota
      ? { quotaCheck: deps.usageQuota.check, quotaRefund: deps.usageQuota.refund }
      : {}),
    ...(deps.usageMetrics ? { metrics: deps.usageMetrics } : {}),
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
