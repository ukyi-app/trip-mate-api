import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, registerErrorFilter } from "../../core/errors.ts";
import type { MembershipLookup, SessionResolver } from "../../core/guards.ts";
import { createApp } from "../../core/openapi.ts";
import type { UsageDraft } from "../usage-imports/usage-imports.schema.ts";
import { registerExpenseDraftRoutes } from "./expense-drafts.controller.ts";
import type { DraftRow } from "./expense-drafts.repo.ts";
import type { ExpenseDraftsService } from "./expense-drafts.service.ts";

const TRIP_ID = "a3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b90";
const DRAFT_ID = "b3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b91";
const EXPENSE_ID = "c3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b92";
const MEMBER_ID = "d3bb189e-8bf9-4c8b-9f36-6c5c8b2a1b93";

const PAYLOAD: UsageDraft = {
  title: "스타벅스",
  local_amount: "6500",
  local_currency: "KRW",
  spent_at: "2026-07-05T03:30:00Z",
  confidence: 0.9,
};
const draftRow = (over: Partial<DraftRow> = {}): DraftRow => ({
  id: DRAFT_ID,
  source: "text",
  status: "pending",
  confirmed_expense_id: null,
  payload: PAYLOAD,
  confirm_payload: null,
  ...over,
});

function appWith(service: Partial<ExpenseDraftsService>, opts: { member?: boolean } = {}) {
  const app = createApp();
  registerErrorFilter(app);
  const resolver: SessionResolver = async () => ({ user: { id: "u1" } });
  const memberLookup: MembershipLookup = async () =>
    opts.member === false ? null : { id: MEMBER_ID, role: "member", status: "joined" };
  registerExpenseDraftRoutes(app, {
    service: service as ExpenseDraftsService,
    resolver,
    memberLookup,
  });
  return app;
}
const base = `/trips/${TRIP_ID}/expense-drafts`;

describe("expense-drafts 라우트", () => {
  it("GET — pending 초안 목록(응답 DTO shape)", async () => {
    const app = appWith({ listDrafts: async () => [draftRow()] });
    const res = await app.request(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: Record<string, unknown>[] };
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({ ...PAYLOAD, id: DRAFT_ID, status: "pending" });
  });

  it("GET — 비멤버 403", async () => {
    const app = appWith({ listDrafts: async () => [] }, { member: false });
    expect((await app.request(base)).status).toBe(403);
  });

  it("PATCH — 초안 편집(부분수정) → 갱신된 초안 반환", async () => {
    let received: unknown;
    const app = appWith({
      updateDraft: async (_t, _m, _id, patch) => {
        received = patch;
        return draftRow({ payload: { ...PAYLOAD, title: "이디야" } });
      },
    });
    const res = await app.request(`${base}/${DRAFT_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "이디야" }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual({ title: "이디야" });
    expect((await res.json()) as { title: string }).toMatchObject({ title: "이디야" });
  });

  it("PATCH — 확정된 초안 편집 시 서비스 ConflictError → 409", async () => {
    const app = appWith({
      updateDraft: async () => {
        throw new ConflictError("draft not editable");
      },
    });
    const res = await app.request(`${base}/${DRAFT_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("POST confirm — 200 {draft_id, expense_id}, memberId 미들웨어에서 전달", async () => {
    let actorMemberId: string | undefined;
    const app = appWith({
      confirmDraft: async (_t, id, _c, actor) => {
        actorMemberId = actor.memberId;
        return { draftId: id, expenseId: EXPENSE_ID };
      },
    });
    const res = await app.request(`${base}/${DRAFT_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paid_by_member_id: MEMBER_ID,
        participant_member_ids: [MEMBER_ID],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft_id: DRAFT_ID, expense_id: EXPENSE_ID });
    expect(actorMemberId).toBe(MEMBER_ID);
  });

  it("POST confirm — 결제자 누락 → 422", async () => {
    const app = appWith({
      confirmDraft: async () => ({ draftId: DRAFT_ID, expenseId: EXPENSE_ID }),
    });
    const res = await app.request(`${base}/${DRAFT_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participant_member_ids: [MEMBER_ID] }),
    });
    expect(res.status).toBe(422);
  });

  it("POST confirm — manualRate·card_billed 동시 → 422(지출 생성과 동일 상호배제)", async () => {
    const app = appWith({
      confirmDraft: async () => ({ draftId: DRAFT_ID, expenseId: EXPENSE_ID }),
    });
    const res = await app.request(`${base}/${DRAFT_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paid_by_member_id: MEMBER_ID,
        participant_member_ids: [MEMBER_ID],
        manualRate: "9.32",
        card_billed_settlement_amount: "6500",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("POST confirm — 이미 확정(서비스 ConflictError) → 409", async () => {
    const app = appWith({
      confirmDraft: async () => {
        throw new ConflictError("draft already confirmed or discarded");
      },
    });
    const res = await app.request(`${base}/${DRAFT_ID}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paid_by_member_id: MEMBER_ID, participant_member_ids: [MEMBER_ID] }),
    });
    expect(res.status).toBe(409);
  });

  it("DELETE — 200 {id, discarded:true}", async () => {
    const app = appWith({ discardDraft: async () => {} });
    const res = await app.request(`${base}/${DRAFT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: DRAFT_ID, discarded: true });
  });

  it("DELETE — 부재/확정됨(서비스 NotFoundError) → 404", async () => {
    const app = appWith({
      discardDraft: async () => {
        throw new NotFoundError("draft not found or not pending");
      },
    });
    const res = await app.request(`${base}/${DRAFT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
