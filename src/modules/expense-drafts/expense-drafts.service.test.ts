import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../core/errors.ts";
import type { CreateExpense } from "../expenses/expenses.schema.ts";
import type { UsageDraft } from "../usage-imports/usage-imports.schema.ts";
import type { DraftRepo, DraftRow } from "./expense-drafts.repo.ts";
import type { ConfirmExpenseDraft } from "./expense-drafts.schema.ts";
import {
  ExpenseDraftsService,
  buildCreateExpense,
  toDraftResponse,
} from "./expense-drafts.service.ts";

const DRAFT: UsageDraft = {
  title: "스타벅스",
  local_amount: "6500",
  local_currency: "KRW",
  spent_at: "2026-07-05T03:30:00Z",
  confidence: 0.9,
};
const row = (over: Partial<DraftRow> = {}): DraftRow => ({
  id: "a3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b90",
  source: "text",
  status: "pending",
  confirmed_expense_id: null,
  payload: DRAFT,
  confirm_payload: null,
  ...over,
});
const CONFIRM: ConfirmExpenseDraft = {
  paid_by_member_id: "b3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b91",
  participant_member_ids: ["b3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b91"],
};

// 제어 가능한 fake repo — 각 메서드 스텁을 주입.
function fakeRepo(over: Partial<DraftRepo> = {}): DraftRepo {
  return {
    createMany: async () => [],
    listPending: async () => [],
    findById: async () => null,
    updatePayload: async () => null,
    claimForConfirm: async () => null,
    setConfirmedExpense: async () => {},
    revertToPending: async () => {},
    softDelete: async () => true,
    ...over,
  };
}

describe("buildCreateExpense (순수)", () => {
  it("초안 필드 프리필 + confirm 완성필드(결제자·참여자) 결합", () => {
    const out = buildCreateExpense(DRAFT, CONFIRM);
    expect(out).toMatchObject({
      title: "스타벅스",
      local_amount: "6500",
      local_currency: "KRW",
      spent_at: "2026-07-05T03:30:00Z",
      paid_by_member_id: CONFIRM.paid_by_member_id,
      participant_member_ids: CONFIRM.participant_member_ids,
    });
  });

  it("category·payment_method: confirm > 초안 > 기본값(other/card)", () => {
    // 초안·confirm 모두 미지정 → 기본값
    expect(buildCreateExpense(DRAFT, CONFIRM)).toMatchObject({
      category: "other",
      payment_method: "card",
    });
    // 초안 값 존재 → 초안 사용
    expect(
      buildCreateExpense({ ...DRAFT, category: "food", payment_method: "cash" }, CONFIRM),
    ).toMatchObject({ category: "food", payment_method: "cash" });
    // confirm 값이 초안보다 우선
    expect(
      buildCreateExpense(
        { ...DRAFT, category: "food" },
        { ...CONFIRM, category: "transport", payment_method: "easy_pay" },
      ),
    ).toMatchObject({ category: "transport", payment_method: "easy_pay" });
  });

  it("undefined 완성필드는 생략(exactOptionalPropertyTypes 준수)", () => {
    const out = buildCreateExpense(DRAFT, CONFIRM);
    expect("memo" in out).toBe(false);
    expect("manualRate" in out).toBe(false);
    expect("card_billed_settlement_amount" in out).toBe(false);
  });
});

describe("toDraftResponse", () => {
  it("payload flatten + 메타(id·source·status·confirmed_expense_id)", () => {
    expect(toDraftResponse(row({ confirmed_expense_id: "x" }))).toEqual({
      ...DRAFT,
      id: row().id,
      source: "text",
      status: "pending",
      confirmed_expense_id: "x",
    });
  });
});

describe("ExpenseDraftsService.updateDraft", () => {
  const creator = { createExpense: async () => ({ id: "e1" }) };

  it("pending 초안 편집 → payload 병합 후 갱신", async () => {
    let mergedPayload: UsageDraft | undefined;
    const repo = fakeRepo({
      findById: async () => row(),
      updatePayload: async (_t, _m, _id, payload) => {
        mergedPayload = payload;
        return row({ payload });
      },
    });
    const svc = new ExpenseDraftsService(repo, creator);
    await svc.updateDraft("t", "m", row().id, { title: "이디야", confidence: 0.5 });
    expect(mergedPayload).toMatchObject({ title: "이디야", confidence: 0.5, local_amount: "6500" });
  });

  it("존재하지 않는/비소유 초안 → NotFoundError", async () => {
    const svc = new ExpenseDraftsService(fakeRepo(), creator);
    await expect(svc.updateDraft("t", "m", "x", { title: "y" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("이미 확정된 초안 편집 → ConflictError", async () => {
    const repo = fakeRepo({ findById: async () => row({ status: "confirmed" }) });
    const svc = new ExpenseDraftsService(repo, creator);
    await expect(svc.updateDraft("t", "m", row().id, { title: "y" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("ExpenseDraftsService.confirmDraft (claim-first saga)", () => {
  it("성공 — claim → createExpense(멱등키 draft:<id>) → expense 링크", async () => {
    const calls: { idem: string | undefined }[] = [];
    let linked: string | undefined;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      setConfirmedExpense: async (_t, _m, _id, expenseId) => {
        linked = expenseId;
      },
    });
    const creator = {
      createExpense: async (_t: string, _i: CreateExpense, _a: unknown, idem?: string) => {
        calls.push({ idem });
        return { id: "exp-1" };
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-1" });
    expect(linked).toBe("exp-1");
    expect(calls[0]!.idem).toBe(`draft:${row().id}`); // 재확정 dedup
  });

  it("claim 실패(동시·교차 확정) → ConflictError, createExpense 미호출", async () => {
    let created = 0;
    const repo = fakeRepo({ findById: async () => row(), claimForConfirm: async () => null });
    const creator = {
      createExpense: async () => {
        created++;
        return { id: "e" };
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    await expect(
      svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(created).toBe(0);
  });

  it("이미 확정+링크된 초안 재확정 → 지출 재생성 없이 기존 결과 리플레이(멱등)", async () => {
    let created = 0;
    let claimed = 0;
    const repo = fakeRepo({
      findById: async () => row({ status: "confirmed", confirmed_expense_id: "exp-9" }),
      claimForConfirm: async () => {
        claimed++;
        return row();
      },
    });
    const creator = {
      createExpense: async () => {
        created++;
        return { id: "new" };
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-9" });
    expect(created).toBe(0); // 재생성 없음
    expect(claimed).toBe(0); // 클레임도 시도 안 함
  });

  it("확정+미링크(부분 실패 잔여) 재확정 → 복구: 멱등키로 재생성·재링크", async () => {
    let idem: string | undefined;
    let linked: string | undefined;
    const repo = fakeRepo({
      findById: async () => row({ status: "confirmed", confirmed_expense_id: null }),
      setConfirmedExpense: async (_t, _m, _id, expenseId) => {
        linked = expenseId;
      },
    });
    const creator = {
      createExpense: async (_t: string, _i: CreateExpense, _a: unknown, key?: string) => {
        idem = key;
        return { id: "exp-recovered" }; // 선행 성공분이면 멱등 dedup으로 동일 id
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-recovered" });
    expect(idem).toBe(`draft:${row().id}`); // 안정 멱등키 → 중복 없이 복구
    expect(linked).toBe("exp-recovered");
  });

  it("확정+미링크 복구 — 요청 body가 달라도 **바인딩된**(최초 claim) body로 지출 구성(경합 결정성)", async () => {
    const boundConfirm: ConfirmExpenseDraft = {
      paid_by_member_id: "aaaa1111-8bf9-4c8b-9f36-6c5c8b2a1b91",
      participant_member_ids: ["aaaa1111-8bf9-4c8b-9f36-6c5c8b2a1b91"],
    };
    let usedPaidBy: string | undefined;
    const repo = fakeRepo({
      // 선행 요청 A가 이미 confirmed + confirm_payload(A body) 바인딩, 링크만 실패한 상태.
      findById: async () =>
        row({ status: "confirmed", confirmed_expense_id: null, confirm_payload: boundConfirm }),
    });
    const creator = {
      createExpense: async (_t: string, input: CreateExpense) => {
        usedPaidBy = input.paid_by_member_id;
        return { id: "e" };
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    // 다른 body(CONFIRM = 다른 paid_by)로 재확정 → 바인딩된 A body가 이겨야 함.
    await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(usedPaidBy).toBe(boundConfirm.paid_by_member_id); // 요청 body 아님, 바인딩된 body
  });

  it("폐기된 초안 확정 → ConflictError", async () => {
    const repo = fakeRepo({ findById: async () => row({ status: "discarded" }) });
    const svc = new ExpenseDraftsService(repo, { createExpense: async () => ({ id: "e" }) });
    await expect(
      svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("createExpense 성공 후 링크 실패 → best-effort 무시하고 성공 반환(confirmed 유지)", async () => {
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      setConfirmedExpense: async () => {
        throw new Error("link write failed");
      },
    });
    const creator = { createExpense: async () => ({ id: "exp-2" }) };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-2" }); // 지출 생성됨 → 성공(링크 실패는 무시)
  });

  it("claim이 반환한 payload로 지출 구성(선행 PATCH 반영, findById의 stale 값 아님)", async () => {
    let builtTitle: string | undefined;
    const repo = fakeRepo({
      findById: async () => row(), // stale(구 title)
      claimForConfirm: async () => row({ payload: { ...DRAFT, title: "최신편집" } }), // 커밋된 최신
    });
    const creator = {
      createExpense: async (_t: string, input: CreateExpense) => {
        builtTitle = input.title;
        return { id: "e" };
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(builtTitle).toBe("최신편집");
  });

  it("모호한 인프라 실패(비-AppError) 2회 → 롤백 없이 confirmed-미링크 유지(리뷰 T·Q)", async () => {
    let creates = 0;
    let reverted = 0;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      revertToPending: async () => {
        reverted++;
      },
    });
    const creator = {
      createExpense: async () => {
        creates++;
        throw new Error("connection reset"); // 비-AppError = 커밋됐을 수 있음(모호)
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    await expect(svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" })).rejects.toThrow(
      "connection reset",
    );
    expect(creates).toBe(2); // 최초 + 멱등 재시도
    expect(reverted).toBe(0); // 모호 실패 → 롤백 금지(고아·stale 회피)
  });

  it("첫 시도 모호 실패 후 둘째 AppError → 롤백 안 함(첫 시도 커밋 가능성, 리뷰 BB)", async () => {
    let reverted = 0;
    let creates = 0;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      revertToPending: async () => {
        reverted++;
      },
    });
    const creator = {
      createExpense: async () => {
        creates++;
        if (creates === 1) throw new Error("conn reset after commit"); // 애매 — 커밋했을 수 있음
        throw new ConflictError("trip closed"); // 둘째는 AppError
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    await expect(
      svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(reverted).toBe(0); // 첫 시도가 애매 → 롤백 금지(고아 회피)
  });

  it("롤백 전 지출 존재 증명 — 동시 생성분 있으면 롤백 대신 링크·성공(리뷰 DD)", async () => {
    let reverted = 0;
    let linked: string | undefined;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      setConfirmedExpense: async (_t, _m, _id, eid) => {
        linked = eid;
      },
      revertToPending: async () => {
        reverted++;
      },
    });
    const creator = {
      createExpense: async () => {
        throw new ValidationError("fx unresolved"); // 우리 시도는 실패(AppError)
      },
      findExpenseIdByKey: async () => "exp-concurrent", // 동시 confirmer가 이미 생성
    };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-concurrent" });
    expect(linked).toBe("exp-concurrent"); // 롤백 대신 동시 생성분 링크
    expect(reverted).toBe(0); // 지출 존재 증명됨 → 롤백 안 함(pending+고아 회피)
  });

  it("정의적 도메인 실패(AppError) 2회 → pending 롤백해 편집/재확정 허용(리뷰 V)", async () => {
    let reverted = 0;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      revertToPending: async () => {
        reverted++;
      },
    });
    const creator = {
      createExpense: async () => {
        throw new ValidationError("unresolved fx requires manualRate"); // AppError = 지출 확정적 미생성
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    await expect(
      svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(reverted).toBe(1); // 도메인 실패 → pending 롤백(사용자 수정 후 재확정)
  });

  it("create 커밋 후 관측 실패 잔여 → 재시도 replay로 기존 지출 회수·링크(리뷰 Q)", async () => {
    let linked: string | undefined;
    let creates = 0;
    const repo = fakeRepo({
      findById: async () => row(),
      claimForConfirm: async () => row(),
      setConfirmedExpense: async (_t, _m, _id, expenseId) => {
        linked = expenseId;
      },
    });
    const creator = {
      createExpense: async () => {
        creates++;
        if (creates === 1) throw new Error("post-commit read failed"); // 커밋됐으나 관측 실패
        return { id: "exp-committed" }; // 재시도 = 멱등 replay로 기존 지출 반환
      },
    };
    const svc = new ExpenseDraftsService(repo, creator);
    const r = await svc.confirmDraft("t", row().id, CONFIRM, { memberId: "m1" });
    expect(r).toEqual({ draftId: row().id, expenseId: "exp-committed" });
    expect(linked).toBe("exp-committed");
  });

  it("존재하지 않는/비소유 초안 → NotFoundError", async () => {
    const svc = new ExpenseDraftsService(fakeRepo(), {
      createExpense: async () => ({ id: "e" }),
    });
    await expect(svc.confirmDraft("t", "x", CONFIRM, { memberId: "m1" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("ExpenseDraftsService.discardDraft", () => {
  it("pending 초안 삭제 성공", async () => {
    const svc = new ExpenseDraftsService(fakeRepo({ softDelete: async () => true }), {
      createExpense: async () => ({ id: "e" }),
    });
    await expect(svc.discardDraft("t", "m", row().id)).resolves.toBeUndefined();
  });

  it("pending 아님/부재/비소유 → NotFoundError", async () => {
    const svc = new ExpenseDraftsService(fakeRepo({ softDelete: async () => false }), {
      createExpense: async () => ({ id: "e" }),
    });
    await expect(svc.discardDraft("t", "m", row().id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
