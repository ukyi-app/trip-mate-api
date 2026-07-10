import { describe, it, expect } from "vitest";
import { buildV1App } from "./app.ts";

function docApp() {
  return buildV1App({
    tripsService: {} as never,
    membersService: {} as never,
    expensesService: {} as never,
    settlementsService: {} as never,
    tripDefaults: {} as never,
    resolver: async () => null,
    emailOf: async () => "",
    nameOf: async () => "",
    memberLookup: async () => null,
    idempotencyStore: null,
    expenseDrafts: {} as never,
    consentService: {} as never,
    currenciesService: {} as never,
    webOrigins: ["http://localhost:5173"],
  });
}
const doc = () =>
  docApp().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });

describe("expenses OpenAPI 계약", () => {
  it("expenses 경로 등록(목록·상세·생성·수정·삭제)", () => {
    const paths = Object.keys(doc().paths ?? {});
    expect(paths.some((p) => p.includes("/v1/trips/{tripId}/expenses"))).toBe(true);
    expect(paths.some((p) => p.includes("/expenses/{expenseId}"))).toBe(true);
  });
  it("Expense 스키마 컴포넌트 등록(version·string 금액)", () => {
    const schemas = doc().components?.schemas ?? {};
    expect(schemas.Expense).toBeDefined();
    expect(schemas.CreateExpense).toBeDefined();
  });
  it("Expense 스키마: author/modifier/timestamps 노출(G1)", () => {
    const schemas = doc().components?.schemas ?? {};
    const props = (schemas.Expense as { properties?: Record<string, unknown> }).properties ?? {};
    for (const k of [
      "created_by_member_id",
      "last_modified_by_member_id",
      "created_at",
      "updated_at",
    ])
      expect(props[k]).toBeDefined();
  });
  it("목록: ExpenseList 응답 스키마 + 커서·필터 쿼리 파라미터(§6)", () => {
    const d = doc();
    expect((d.components?.schemas ?? {}).ExpenseList).toBeDefined();
    const key = Object.keys(d.paths ?? {}).find((p) => p.endsWith("/trips/{tripId}/expenses"));
    expect(key).toBeDefined();
    const get = (d.paths as Record<string, { get?: { parameters?: { name: string }[] } }>)[key!]
      ?.get;
    const names = (get?.parameters ?? []).map((p) => p.name);
    for (const n of [
      "limit",
      "cursor",
      "category",
      "payment_method",
      "currency",
      "member",
      "state",
    ])
      expect(names).toContain(n);
  });
  it("FX 확장 경로·스키마(preview·fx-defaults)", () => {
    const paths = Object.keys(doc().paths ?? {});
    expect(paths.some((p) => p.includes("/expenses/preview"))).toBe(true);
    expect(paths.some((p) => p.includes("/fx-defaults"))).toBe(true);
    const schemas = doc().components?.schemas ?? {};
    expect(schemas.ExpensePreview).toBeDefined();
    expect(schemas.SetTripFxDefault).toBeDefined();
  });
  it("생성 라우트에 Idempotency-Key 헤더 파라미터(optional·maxLength 200)", () => {
    type Param = { name: string; in: string; required?: boolean; schema?: { maxLength?: number } };
    const post = (doc().paths as Record<string, { post?: { parameters?: Param[] } }>)[
      "/v1/trips/{tripId}/expenses"
    ]?.post;
    const p = (post?.parameters ?? []).find(
      (x) => x.name === "Idempotency-Key" && x.in === "header",
    );
    expect(p).toBeDefined();
    expect(p!.required).toBe(false);
    expect(p!.schema?.maxLength).toBe(200);
  });
});
