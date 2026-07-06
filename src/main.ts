import IoRedis from "ioredis";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { createApp } from "./core/openapi.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { createCore } from "./core/composition.ts";
import { enforceHostCookie } from "./core/host-cookie.ts";
import { createAuth } from "./auth.ts";
import { mountAuth } from "./modules/auth/mount.ts";
import { authResolver } from "./modules/auth/session.ts";
import { user } from "./db/schema/auth-schema.ts";
import { DrizzleTripRepo } from "./modules/trips/trips.repo.ts";
import { DrizzleMemberRepo } from "./modules/members/members.repo.ts";
import { TripsService } from "./modules/trips/trips.service.ts";
import { MembersService } from "./modules/members/members.service.ts";
import { DrizzleExpenseRepo } from "./modules/expenses/expenses.repo.ts";
import { ExpensesService } from "./modules/expenses/expenses.service.ts";
import { DrizzleSettlementRepo } from "./modules/settlements/settlements.repo.ts";
import { SettlementsService } from "./modules/settlements/settlements.service.ts";
import { RedisCache } from "./modules/fx/cache/cache.redis.ts";
import { DrizzleTripDefaults } from "./modules/fx/trip-defaults.repo.ts";
import { OxrProvider } from "./modules/fx/provider/oxr.ts";
import { CurrencyApiProvider } from "./modules/fx/provider/currencyapi.ts";
import { buildV1App } from "./app.ts";
import { sweepExpiredIdempotency } from "./core/idempotency.ts";
import { runMigrations } from "./db/migrate.ts";
import { rateLimitWrites } from "./core/rate-limit.ts";
import { createMailer } from "./modules/notifications/mailer.resend.ts";
import { FilesClient } from "./modules/files/files.client.ts";
import { DrizzleReceiptRepo } from "./modules/files/receipts.repo.ts";
import { ReceiptsService } from "./modules/files/receipts.service.ts";
import { ClaudeUsageParser } from "./modules/usage-imports/usage-parser.claude.ts";
import { CodexUsageParser } from "./modules/usage-imports/usage-parser.codex.ts";

const core = createCore();
// boot self-migrate(homelab 계약) — 서빙 전 멱등 마이그레이션. 직결 URL, 실패 시 부팅 중단(fail-closed).
await runMigrations(core.migrateUrl);

const app = createApp();
// 루트 앱 onError — app.route("/", v1)로 마운트하면 에러는 루트 onError로 전파(Hono).
// 누락 시 v1의 모든 AppError(403/404/409/422-throw)가 500이 된다(마운트 합성 버그). v1의 필터는 standalone(테스트)용.
registerErrorFilter(app);
const redis = new IoRedis(core.redisUrl); // auth secondaryStorage·FX 캐시(멱등은 DB로 이전)

// auth 싱글톤은 컴포지션 루트에서 구성: db·redis·시크릿·origin 주입.
const auth = createAuth({
  db: core.db,
  redis,
  secret: core.config.BETTER_AUTH_SECRET,
  baseURL: core.config.BETTER_AUTH_URL,
  trustedOrigins: core.config.WEB_ORIGINS,
  useSecureCookies: core.config.USE_SECURE_COOKIES,
  ...(core.config.GOOGLE_CLIENT_ID && core.config.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: core.config.GOOGLE_CLIENT_ID,
          clientSecret: core.config.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
});

// /api/auth: CORS + __Host- 정규화 → Better Auth 마운트(자체 CSRF/origin).
app.use(
  "/api/auth/*",
  cors({
    origin: core.config.WEB_ORIGINS,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/api/auth/*", enforceHostCookie({ secure: core.config.USE_SECURE_COOKIES }));
mountAuth(app, auth);

// /v1: 계약 라우트(buildV1App가 CORS·CSRF·security·라우트 포함). db 첫 인자(tx, finding #4 pass2).
const memberRepo = new DrizzleMemberRepo(core.db);
const membersService = new MembersService(memberRepo, {
  ttlHours: core.config.INVITE_TOKEN_TTL_HOURS,
});
const tripsService = new TripsService(core.db, new DrizzleTripRepo(core.db), membersService);
const emailOf = async (userId: string): Promise<string> => {
  const rows = await core.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return rows[0]?.email ?? "";
};
// FX provider: 키 있을 때만(없으면 identity/manual만). 캐시·trip_default는 항상.
const fxProviders = [
  ...(core.config.OXR_APP_ID ? [new OxrProvider(core.config.OXR_APP_ID)] : []),
  ...(core.config.CURRENCYAPI_KEY ? [new CurrencyApiProvider(core.config.CURRENCYAPI_KEY)] : []),
];
const tripDefaults = new DrizzleTripDefaults(core.db);
const expensesService = new ExpensesService(core.db, new DrizzleExpenseRepo(core.db), {
  providers: fxProviders,
  cache: new RedisCache(redis),
  tripDefaults,
  onWarn: (event, detail) => core.logger.warn({ event, detail }, "fx"),
});
const settlementsService = new SettlementsService(core.db, new DrizzleSettlementRepo(core.db));
const mailer = createMailer({
  from: core.config.MAIL_FROM,
  onError: (e) => core.logger.warn({ err: e }, "invite email send failed"),
  ...(core.config.RESEND_API_KEY ? { apiKey: core.config.RESEND_API_KEY } : {}),
});
// 영수증 프록시 — files 서버 config 있을 때만(없으면 라우트 미등록).
const receipts =
  core.config.FILES_BASE_URL && core.config.FILES_API_KEY
    ? new ReceiptsService(
        new FilesClient(core.config.FILES_BASE_URL, core.config.FILES_API_KEY),
        new DrizzleReceiptRepo(core.db),
        { bucket: core.config.FILES_BUCKET },
      )
    : undefined;
// 사용내역 파싱(LLM) — 엔진 선택(설계 §엔진 선택). codex=구독 CLI, 그 외 키 있으면 Claude, 없으면 503.
const onUsageParseError = (e: unknown) => core.logger.warn({ err: e }, "usage parse failed");
const usageParser =
  core.config.USAGE_PARSER_ENGINE === "codex"
    ? new CodexUsageParser({ onError: onUsageParseError })
    : core.config.ANTHROPIC_API_KEY
      ? new ClaudeUsageParser(core.config.ANTHROPIC_API_KEY, { onError: onUsageParseError })
      : undefined;
if (core.config.USAGE_PARSER_ENGINE === "claude" && !core.config.ANTHROPIC_API_KEY)
  core.logger.warn("USAGE_PARSER_ENGINE=claude이지만 ANTHROPIC_API_KEY 없음 — 파싱 503");
const v1 = buildV1App({
  tripsService,
  membersService,
  expensesService,
  settlementsService,
  tripDefaults,
  resolver: authResolver(auth),
  emailOf,
  memberLookup: (t, u) => memberRepo.findMembership(t, u),
  idempotencyStore: { db: core.db, ttlSeconds: 86_400 }, // DB-durable(§5) — Redis는 auth·FX캐시 전용
  webOrigins: core.config.WEB_ORIGINS,
  rateLimit: rateLimitWrites(redis, { scope: "v1w", max: 60, windowSec: 60 }), // 공개 API 쓰기 60/min/IP
  mailer, // 초대 이메일(Resend 또는 no-op)
  ...(receipts ? { receipts } : {}), // 영수증 프록시(files 서버)
  ...(usageParser ? { usageParser } : {}), // 사용내역 파싱(LLM)
});
app.route("/", v1); // v1 라우트는 /v1/... (basePath)

app.get("/health", (c) => c.json({ status: "ok" })); // liveness(차트 probe)
app.get("/ready", (c) => c.json({ status: "ready" })); // readiness(차트 probe) — boot migrate 후 서빙

// 만료 멱등 행 주기 정리(Redis EX 자동 eviction 대체). unref로 단독 프로세스 유지 안 함.
setInterval(() => {
  void sweepExpiredIdempotency(core.db).catch((err) =>
    core.logger.warn({ err }, "idempotency sweep failed"),
  );
}, 3_600_000).unref();

export default { port: core.config.PORT, fetch: app.fetch }; // 차트 ports.http=8080
