import { describe, expect, it } from "vitest";
import { ConflictError, registerErrorFilter } from "../../core/errors.ts";
import type { SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import { registerConsentRoutes } from "./consents.controller.ts";
import type { ConsentService } from "./consents.service.ts";

function appWith(service: Partial<ConsentService>, opts: { auth?: boolean } = {}) {
  const app = createApp();
  registerErrorFilter(app);
  const resolver: SessionResolver = async () =>
    opts.auth === false ? null : { user: { id: "u1" } };
  registerConsentRoutes(app, { service: service as ConsentService, resolver });
  return app;
}
const V = CONSENT_VERSIONS;
const AT = new Date("2026-07-07T00:00:00Z");

describe("consents 라우트", () => {
  it("POST — 200 {recorded}, service.record에 userId·consents·source 전달", async () => {
    let seen: unknown;
    const app = appWith({
      record: async (userId, input) => {
        seen = { userId, input };
        return [{ consent_type: "tos", document_version: V.tos, accepted_at: AT }];
      },
    });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }], source: "signup" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recorded: [{ type: "tos", version: V.tos, accepted_at: "2026-07-07T00:00:00.000Z" }],
    });
    expect(seen).toMatchObject({
      userId: "u1",
      input: { consents: [{ type: "tos", version: V.tos }], source: "signup" },
    });
  });

  it("POST — stale(service ConflictError) → 409 problem+json", async () => {
    const app = appWith({
      record: async () => {
        throw new ConflictError("stale consent version");
      },
    });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: "old" }], source: "signup" }),
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("POST — 미인증 → 403", async () => {
    const app = appWith({ record: async () => [] }, { auth: false });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }], source: "signup" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST — source 누락 → 422", async () => {
    const app = appWith({ record: async () => [] });
    const res = await app.request("/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consents: [{ type: "tos", version: V.tos }] }),
    });
    expect(res.status).toBe(422);
  });

  it("GET — 200 {current, accepted}", async () => {
    const app = appWith({
      list: async () => ({
        current: CONSENT_VERSIONS,
        accepted: [
          { consent_type: "llm_disclosure", document_version: V.llm_disclosure, accepted_at: AT },
        ],
      }),
    });
    const res = await app.request("/consents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: unknown; accepted: unknown[] };
    expect(body.current).toEqual(CONSENT_VERSIONS);
    expect(body.accepted).toEqual([
      {
        type: "llm_disclosure",
        version: V.llm_disclosure,
        accepted_at: "2026-07-07T00:00:00.000Z",
      },
    ]);
  });

  it("GET — 미인증 → 403", async () => {
    const app = appWith(
      { list: async () => ({ current: CONSENT_VERSIONS, accepted: [] }) },
      { auth: false },
    );
    expect((await app.request("/consents")).status).toBe(403);
  });
});
