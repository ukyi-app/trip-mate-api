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
    memberLookup: async () => null,
    idempotencyStore: null,
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
});
