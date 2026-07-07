import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkMember, mkTrip, mkUser, startDb, type Ctx } from "../../../tests/db/helpers.ts";
import type { ConfirmExpenseDraft } from "./expense-drafts.schema.ts";
import type { UsageDraft } from "../usage-imports/usage-imports.schema.ts";
import { DrizzleDraftRepo, type DraftRepo } from "./expense-drafts.repo.ts";

let ctx: Ctx;
let repo: DraftRepo;
beforeAll(async () => {
  ctx = await startDb();
  repo = new DrizzleDraftRepo(ctx.db);
});
afterAll(async () => {
  await ctx.sql.end();
  await ctx.container.stop();
});

const DRAFT: UsageDraft = {
  title: "스타벅스",
  local_amount: "6500",
  local_currency: "KRW",
  spent_at: "2026-07-05T03:30:00Z",
  confidence: 0.9,
};
const CONFIRM: ConfirmExpenseDraft = {
  paid_by_member_id: "c3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b92",
  participant_member_ids: ["c3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b92"],
};

// 격리된 trip + joined 멤버(member_id) 준비. member2로 교차-멤버 격리 검증.
async function setup() {
  const u = await mkUser(ctx.sql);
  const trip = await mkTrip(ctx.sql, u);
  const member = await mkMember(ctx.sql, trip, { userId: u, role: "admin", status: "joined" });
  const u2 = await mkUser(ctx.sql);
  const member2 = await mkMember(ctx.sql, trip, { userId: u2, role: "member", status: "joined" });
  return { trip, member, member2 };
}

describe("DrizzleDraftRepo", () => {
  it("createMany — 저장 후 id·status(pending)·payload 반환, 빈 배열은 no-op", async () => {
    const { trip, member } = await setup();
    expect(await repo.createMany(trip, member, [], "text")).toEqual([]);
    const rows = await repo.createMany(trip, member, [DRAFT, { ...DRAFT, title: "김밥" }], "text");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBeTruthy();
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.source).toBe("text");
    expect(rows.map((r) => r.payload.title).sort()).toEqual(["김밥", "스타벅스"]);
  });

  it("listPending — pending·confirmed-미링크 포함(desc), confirmed-링크·discarded 제외(리뷰 Z)", async () => {
    const { trip, member } = await setup();
    const [a, b] = await repo.createMany(trip, member, [DRAFT, { ...DRAFT, title: "B" }], "text");
    // a를 과거로 → desc 정렬이면 b가 먼저
    await ctx.sql`update expense_drafts set created_at = now() - interval '1 hour' where id = ${a!.id}`;
    await repo.claimForConfirm(trip, member, b!.id, CONFIRM); // b → confirmed-미링크(in-progress, 포함)
    // C는 confirmed + 링크 → 완료(목록 제외)
    const c = await repo.createMany(trip, member, [{ ...DRAFT, title: "C" }], "text");
    await repo.claimForConfirm(trip, member, c[0]!.id, CONFIRM);
    await repo.setConfirmedExpense(trip, member, c[0]!.id, "e3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b99");
    const list = await repo.listPending(trip, member);
    // a(pending) + b(confirmed-미링크) 포함, C(confirmed-링크) 제외. desc: b(now) > a(1h전)
    expect(list.map((r) => r.payload.title)).toEqual(["B", "스타벅스"]);
  });

  it("listPending — 타 멤버 초안은 보이지 않는다(개인 큐)", async () => {
    const { trip, member, member2 } = await setup();
    await repo.createMany(trip, member, [DRAFT], "text");
    expect(await repo.listPending(trip, member2)).toEqual([]); // member2는 자기 것만
    expect(await repo.listPending(trip, member)).toHaveLength(1);
  });

  it("findById — trip·소유 멤버 스코프(타 trip·타 멤버는 null)", async () => {
    const { trip, member, member2 } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text");
    expect((await repo.findById(trip, member, d!.id))?.id).toBe(d!.id);
    expect(await repo.findById(trip, member2, d!.id)).toBeNull(); // 타 멤버 접근 차단
    const other = await setup();
    expect(await repo.findById(other.trip, member, d!.id)).toBeNull(); // 타 trip 차단
  });

  it("updatePayload — 소유 멤버·pending만 갱신, confirmed·타 멤버는 null", async () => {
    const { trip, member, member2 } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text");
    expect(await repo.updatePayload(trip, member2, d!.id, { ...DRAFT, title: "침입" })).toBeNull();
    const updated = await repo.updatePayload(trip, member, d!.id, {
      ...DRAFT,
      title: "수정",
      confidence: 0.4,
    });
    expect(updated?.payload).toMatchObject({ title: "수정", confidence: 0.4 });
    await repo.claimForConfirm(trip, member, d!.id, CONFIRM); // → confirmed
    expect(await repo.updatePayload(trip, member, d!.id, { ...DRAFT, title: "재수정" })).toBeNull();
  });

  it("claimForConfirm — 원자 전이: 첫 요청만 payload 반환, 재클레임·타 멤버 null", async () => {
    const { trip, member, member2 } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text");
    expect(await repo.claimForConfirm(trip, member2, d!.id, CONFIRM)).toBeNull(); // 타 멤버 확정 불가
    const won = await repo.claimForConfirm(trip, member, d!.id, CONFIRM);
    expect(won?.payload).toMatchObject({ title: "스타벅스" }); // 클레임 시점 커밋 payload 원자 반환
    expect(won?.confirm_payload).toEqual(CONFIRM); // 확정 body 원자 바인딩(복구 결정성)
    // 다른 body로 재클레임 시도해도 null(이미 confirmed) → 바인딩된 body는 불변.
    expect(
      await repo.claimForConfirm(trip, member, d!.id, {
        paid_by_member_id: "d3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b93",
        participant_member_ids: ["d3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b93"],
      }),
    ).toBeNull();
    expect((await repo.findById(trip, member, d!.id))?.confirm_payload).toEqual(CONFIRM); // 최초 body 유지
  });

  it("setConfirmedExpense — confirmed 행에 지출 링크(status 유지)", async () => {
    const { trip, member } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text");
    await repo.claimForConfirm(trip, member, d!.id, CONFIRM);
    await repo.setConfirmedExpense(trip, member, d!.id, "e3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b99");
    const after = await repo.findById(trip, member, d!.id);
    expect(after?.status).toBe("confirmed");
    expect(after?.confirmed_expense_id).toBe("e3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b99");
  });

  it("createMany importKey — 같은 키 재호출은 재삽입 없이 기존 배치 replay(크래시-갭 방어)", async () => {
    const { trip, member } = await setup();
    const first = await repo.createMany(trip, member, [DRAFT, { ...DRAFT, title: "B" }], "text", {
      importKey: "imp-1",
    });
    expect(first).toHaveLength(2);
    // 다른 내용으로 재호출해도(재시도) 기존 배치를 반환 — 새 삽입 없음.
    const second = await repo.createMany(trip, member, [{ ...DRAFT, title: "C" }], "text", {
      importKey: "imp-1",
    });
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort()); // 동일 행 replay
    expect(await repo.listPending(trip, member)).toHaveLength(2); // 배치 1개만 존재
    // 다른 키는 별도 배치.
    const third = await repo.createMany(trip, member, [DRAFT], "text", { importKey: "imp-2" });
    expect(third).toHaveLength(1);
    expect(await repo.listPending(trip, member)).toHaveLength(3);
  });

  it("createMany importKey — discard 후 재시도는 배치 부활 안 함(리뷰 CC)", async () => {
    const { trip, member } = await setup();
    const first = await repo.createMany(trip, member, [DRAFT, { ...DRAFT, title: "B" }], "text", {
      importKey: "imp-d",
    });
    await repo.softDelete(trip, member, first[0]!.id); // 배치 중 하나 discard
    // 같은 키 재시도(다른 내용) → 재삽입 금지, 살아있는 것(B)만 반환.
    const retry = await repo.createMany(trip, member, [{ ...DRAFT, title: "new" }], "text", {
      importKey: "imp-d",
    });
    expect(retry.map((r) => r.payload.title)).toEqual(["B"]); // new 삽입 안 됨
    expect(await repo.listPending(trip, member)).toHaveLength(1); // 부활 없음
    // 전부 discard 후 재시도 → 빈 배열(부활 없음)
    await repo.softDelete(trip, member, first[1]!.id);
    const retry2 = await repo.createMany(trip, member, [DRAFT], "text", { importKey: "imp-d" });
    expect(retry2).toEqual([]);
    expect(await repo.listPending(trip, member)).toEqual([]);
  });

  it("setConfirmedExpense — pending(미클레임) 행엔 링크 안 함(pending+링크 유령행 방지, 리뷰 S)", async () => {
    const { trip, member } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text"); // pending(미클레임)
    await repo.setConfirmedExpense(trip, member, d!.id, "aaaa1111-8bf9-4c8b-9f36-6c5c8b2a1b91");
    const after = await repo.findById(trip, member, d!.id);
    expect(after?.status).toBe("pending");
    expect(after?.confirmed_expense_id).toBeNull(); // confirmed 아님 → 링크 거부
  });

  it("revertToPending — 미링크 confirmed만 롤백, 링크된 행은 불변(고아 방지)", async () => {
    const { trip, member } = await setup();
    const [d] = await repo.createMany(trip, member, [DRAFT], "text");
    await repo.claimForConfirm(trip, member, d!.id, CONFIRM); // confirmed, 미링크
    await repo.revertToPending(trip, member, d!.id);
    expect((await repo.findById(trip, member, d!.id))?.status).toBe("pending"); // 롤백됨
    // 재클레임 + 링크 → 이후 revert는 무효(이미 링크됨)
    await repo.claimForConfirm(trip, member, d!.id, CONFIRM);
    await repo.setConfirmedExpense(trip, member, d!.id, "e3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b99");
    await repo.revertToPending(trip, member, d!.id);
    const after = await repo.findById(trip, member, d!.id);
    expect(after?.status).toBe("confirmed"); // 링크된 것은 롤백 제외
    expect(after?.confirmed_expense_id).toBe("e3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b99");
  });

  it("softDelete — 소유 멤버·pending만 true(discarded), 타 멤버·confirmed는 false", async () => {
    const { trip, member, member2 } = await setup();
    const [a, b] = await repo.createMany(trip, member, [DRAFT, { ...DRAFT, title: "B" }], "text");
    expect(await repo.softDelete(trip, member2, a!.id)).toBe(false); // 타 멤버 삭제 불가
    expect(await repo.softDelete(trip, member, a!.id)).toBe(true);
    expect(await repo.findById(trip, member, a!.id)).toBeNull(); // deleted_at → 조회 제외
    await repo.claimForConfirm(trip, member, b!.id, CONFIRM);
    expect(await repo.softDelete(trip, member, b!.id)).toBe(false); // confirmed 삭제 불가
  });
});
