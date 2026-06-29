import IoRedis from "ioredis";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { createApp } from "./core/openapi.ts";
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
import { buildV1App } from "./app.ts";

const core = createCore();
const app = createApp();

// auth 싱글톤은 컴포지션 루트에서 구성: db·redis·시크릿·origin 주입.
const auth = createAuth({
  db: core.db,
  redis: new IoRedis(core.config.VALKEY_URL),
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
const v1 = buildV1App({
  tripsService,
  membersService,
  resolver: authResolver(auth),
  emailOf,
  memberLookup: (t, u) => memberRepo.findMembership(t, u),
  webOrigins: core.config.WEB_ORIGINS,
});
app.route("/", v1); // v1 라우트는 /v1/... (basePath)

app.get("/health", (c) => c.json({ status: "ok" }));

export default { port: 3000, fetch: app.fetch };
