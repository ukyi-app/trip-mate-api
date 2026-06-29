import { describe, it, expect } from "vitest";
import { buildV1App } from "./app.ts";

function docApp() {
  return buildV1App({
    tripsService: {} as never,
    membersService: {} as never,
    expensesService: {} as never,
    settlementsService: {} as never,
    resolver: async () => null,
    emailOf: async () => "",
    memberLookup: async () => null,
    idempotencyStore: null,
    webOrigins: ["http://localhost:5173"],
  });
}
const doc = () =>
  docApp().getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } });

describe("settlement OpenAPI 계약", () => {
  it("settlement 경로 등록(GET·precheck·finalize·unlock·mark-paid)", () => {
    const paths = Object.keys(doc().paths ?? {});
    expect(paths.some((p) => p.endsWith("/settlement"))).toBe(true);
    expect(paths.some((p) => p.includes("/settlement/finalize"))).toBe(true);
    expect(paths.some((p) => p.includes("/settlement/unlock"))).toBe(true);
    expect(paths.some((p) => p.includes("/settlement/transfers/{transferId}/mark-paid"))).toBe(
      true,
    );
  });
  it("Settlement 스키마 컴포넌트 등록", () => {
    const schemas = doc().components?.schemas ?? {};
    expect(schemas.Settlement).toBeDefined();
    expect(schemas.FinalizeSettlement).toBeDefined();
  });
});
