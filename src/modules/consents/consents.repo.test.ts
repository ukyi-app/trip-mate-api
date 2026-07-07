import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkUser, startDb, type Ctx } from "../../../tests/db/helpers.ts";
import { DrizzleConsentRepo, type ConsentRepo } from "./consents.repo.ts";

let ctx: Ctx;
let repo: ConsentRepo;
beforeAll(async () => {
  ctx = await startDb();
  repo = new DrizzleConsentRepo(ctx.db);
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

describe("DrizzleConsentRepo", () => {
  it("insertMany + listByUser — tos·privacy 기록 후 조회(accepted_at 포함)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
      { user_id: u, consent_type: "privacy", document_version: "v1", source: "signup" },
    ]);
    const rows = await repo.listByUser(u);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.consent_type).sort()).toEqual(["privacy", "tos"]);
    expect(rows[0]!.accepted_at).toBeInstanceOf(Date);
  });

  it("멱등 — 같은 (user,type,version) 재삽입 no-op(ON CONFLICT DO NOTHING)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
    ]);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "settings" },
    ]);
    expect(await repo.listByUser(u)).toHaveLength(1);
  });

  it("버전 다르면 별도 행(재동의)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v1", source: "signup" },
    ]);
    await repo.insertMany([
      { user_id: u, consent_type: "tos", document_version: "v2", source: "settings" },
    ]);
    expect(await repo.listByUser(u)).toHaveLength(2);
  });

  it("ip 저장(감사용)", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([
      {
        user_id: u,
        consent_type: "llm_disclosure",
        document_version: "v1",
        source: "usage_parse",
        ip: "1.2.3.4",
      },
    ]);
    const rows = await ctx.sql`select ip from user_consents where user_id = ${u}`;
    expect(rows[0]!.ip).toBe("1.2.3.4");
  });

  it("빈 배열 no-op", async () => {
    const u = await mkUser(ctx.sql);
    await repo.insertMany([]);
    expect(await repo.listByUser(u)).toEqual([]);
  });
});
