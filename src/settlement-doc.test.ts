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
  it("reversal/history 경로·스키마 등록", () => {
    const d = doc();
    const paths = Object.keys(d.paths ?? {});
    expect(paths.some((p) => p.endsWith("/transfers/{transferId}/mark-unpaid"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/settlement/history"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/transfers/{transferId}/events"))).toBe(true);
    const schemas = d.components?.schemas ?? {};
    expect(schemas.SettlementHistoryEntry).toBeDefined();
    expect(schemas.TransferEvent).toBeDefined();
    expect(schemas.MarkUnpaidResult).toBeDefined();
  });
  it("멱등 4개 라우트에 Idempotency-Key 헤더 파라미터(optional·maxLength 200)", () => {
    type Param = { name: string; in: string; required?: boolean; schema?: { maxLength?: number } };
    const d = doc();
    const targets = [
      "/v1/trips/{tripId}/settlement/finalize",
      "/v1/trips/{tripId}/settlement/unlock",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-paid",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid",
    ];
    for (const path of targets) {
      const post = (d.paths as Record<string, { post?: { parameters?: Param[] } }>)[path]?.post;
      const p = (post?.parameters ?? []).find(
        (x) => x.name === "Idempotency-Key" && x.in === "header",
      );
      expect(p, path).toBeDefined();
      expect(p!.required, path).toBe(false);
      expect(p!.schema?.maxLength, path).toBe(200);
    }
  });
  it("멱등 4개 라우트가 헤더 검증 실패에 대한 422 응답 선언(Idempotency-Key >200자 → problem+json, FE codegen 정합)", () => {
    const d = doc();
    const targets = [
      "/v1/trips/{tripId}/settlement/finalize",
      "/v1/trips/{tripId}/settlement/unlock",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-paid",
      "/v1/trips/{tripId}/settlement/transfers/{transferId}/mark-unpaid",
    ];
    for (const path of targets) {
      const post = (d.paths as Record<string, { post?: { responses?: Record<string, unknown> } }>)[
        path
      ]?.post;
      expect(post?.responses?.["422"], path).toBeDefined();
    }
  });
});
