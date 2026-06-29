import IoRedis from "ioredis";
import { cors } from "hono/cors";
import { createApp } from "./core/openapi.ts";
import { createCore } from "./core/composition.ts";
import { registerErrorFilter } from "./core/errors.ts";
import { enforceHostCookie } from "./core/host-cookie.ts";
import { createAuth } from "./auth.ts";
import { mountAuth } from "./modules/auth/mount.ts";

const core = createCore();
const app = createApp();

// auth 싱글톤은 컴포지션 루트에서 구성(finding #2 pass2): db·redis·시크릿·origin 주입. top-level 싱글톤 없음.
const auth = createAuth({
  db: core.db,
  redis: new IoRedis(core.config.VALKEY_URL),
  secret: core.config.BETTER_AUTH_SECRET,
  baseURL: core.config.BETTER_AUTH_URL,
  trustedOrigins: core.config.WEB_ORIGINS,
  useSecureCookies: core.config.USE_SECURE_COOKIES,
  // exactOptionalPropertyTypes: 명시적 undefined 금지 → 키를 조건부로 생략(spread).
  ...(core.config.GOOGLE_CLIENT_ID && core.config.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: core.config.GOOGLE_CLIENT_ID,
          clientSecret: core.config.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
});

// CORS(credentialed 교차 서브도메인) → __Host- 쿠키 정규화 → Better Auth 마운트.
// 와일드카드 금지(credentials와 양립 불가). 미배선 시 host-only 쿠키·CSRF가 맞아도 브라우저가 응답 차단(finding pass3).
const corsMw = cors({
  origin: core.config.WEB_ORIGINS, // 배열 정확 일치 → 매칭 origin echo, 미매칭은 헤더 미부여(브라우저 거부)
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});
app.use("/api/auth/*", corsMw); // ⚠️ Better Auth가 자체 CORS 헤더를 emit하면 중복 ACAO 방지 위해 reconcile(docs 확인)
app.use("/api/auth/*", enforceHostCookie({ secure: core.config.USE_SECURE_COOKIES })); // 세션 Set-Cookie를 __Host- 로 정규화(finding #1 pass5)
mountAuth(app, auth);

app.get("/health", (c) => c.json({ status: "ok" }));
registerErrorFilter(app);

// ⚠️ 초대수락 라우트는 **test-only**(Task 8) — 비버전 mutation ship 금지. 프로덕션 /v1 라우트 + OpenAPI DTO + cors·csrf·guards·MembersService 배선은 다음 API 슬라이스(finding #2 pass5).
//    (csrf·cors·guards·MembersService·MemberRepo·host-cookie는 라이브러리로 구비·테스트 완료, /v1 배선만 후속.)

export default { port: 3000, fetch: app.fetch };
