import { describe, expect, it } from "vitest";
import { ConflictError } from "../../core/errors.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import type { ConsentRepo, NewConsent } from "./consents.repo.ts";
import { ConsentService } from "./consents.service.ts";

const FIXED = new Date("2026-07-07T00:00:00Z");
function memRepo(): ConsentRepo & { rows: (NewConsent & { accepted_at: Date })[] } {
  const rows: (NewConsent & { accepted_at: Date })[] = [];
  return {
    rows,
    async insertMany(rs) {
      for (const r of rs) {
        const dup = rows.some(
          (x) =>
            x.user_id === r.user_id &&
            x.consent_type === r.consent_type &&
            x.document_version === r.document_version,
        );
        if (!dup) rows.push({ ...r, accepted_at: FIXED });
      }
    },
    async listByUser(userId) {
      return rows
        .filter((r) => r.user_id === userId)
        .map((r) => ({
          consent_type: r.consent_type,
          document_version: r.document_version,
          accepted_at: r.accepted_at,
        }));
    },
  };
}
const V = CONSENT_VERSIONS;

describe("ConsentService.record", () => {
  it("current 버전 batch(tos+privacy) → 멱등 기록·기록분 반환", async () => {
    const repo = memRepo();
    const out = await new ConsentService(repo).record("u1", {
      consents: [
        { type: "tos", version: V.tos },
        { type: "privacy", version: V.privacy },
      ],
      source: "signup",
    });
    expect(out.map((r) => r.consent_type).sort()).toEqual(["privacy", "tos"]);
    expect(repo.rows).toHaveLength(2);
  });

  it("stale 버전 → ConflictError, insert 미도달", async () => {
    const repo = memRepo();
    await expect(
      new ConsentService(repo).record("u1", {
        consents: [{ type: "tos", version: "old" }],
        source: "signup",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.rows).toHaveLength(0);
  });

  it("재수락 멱등 — 같은 버전 2회 → 1행", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    const input = {
      consents: [{ type: "tos" as const, version: V.tos }],
      source: "settings" as const,
    };
    await svc.record("u1", input);
    await svc.record("u1", input);
    expect(repo.rows).toHaveLength(1);
  });
});

describe("ConsentService.recordDisclosure", () => {
  it("llm_disclosure(current·source=usage_parse) 멱등 기록", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    await svc.recordDisclosure("u1", { ip: "9.9.9.9" });
    expect(repo.rows).toEqual([
      {
        user_id: "u1",
        consent_type: "llm_disclosure",
        document_version: V.llm_disclosure,
        source: "usage_parse",
        ip: "9.9.9.9",
        accepted_at: FIXED,
      },
    ]);
    await svc.recordDisclosure("u1");
    expect(repo.rows).toHaveLength(1);
  });
});

describe("ConsentService.list", () => {
  it("current + accepted 반환", async () => {
    const repo = memRepo();
    const svc = new ConsentService(repo);
    await svc.recordDisclosure("u1");
    const out = await svc.list("u1");
    expect(out.current).toEqual(CONSENT_VERSIONS);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.consent_type).toBe("llm_disclosure");
  });
});
