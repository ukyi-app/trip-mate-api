import { describe, it, expect } from "vitest";
import { buildV1App } from "./app.ts";

// 핸들러 미실행(스펙은 라우트 config만 읽음) → service stub 안전, 무-IO. gen:openapi와 동일 구성.
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
  docApp().getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "trip-mate API", version: "1.0.0" },
  });

describe("OpenAPI 스펙 계약", () => {
  it("핵심 경로 등록(trips·members·invites, /v1 prefix) + 액션 경로 확정(finding #2 pass5)", () => {
    const paths = Object.keys(doc().paths ?? {});
    expect(paths.some((p) => p.includes("/v1/trips"))).toBe(true);
    expect(paths.some((p) => p.includes("/members"))).toBe(true);
    // 액션 경로는 /accept·/resend(경로-세그먼트)로 확정 — openapi.json이 FE codegen SSOT
    expect(paths.some((p) => p.includes("/invites/{token}/accept"))).toBe(true);
    expect(paths.some((p) => p.includes("/invites/{iid}/resend"))).toBe(true);
    // ④ 어드민 양도 경로(FE codegen SSOT)
    expect(paths.some((p) => p.includes("/members/{memberId}/transfer-admin"))).toBe(true);
  });
  it("초대 취소 라우트 등록(/invites/{inviteId}/revoke) + InviteRevoked 스키마(finding: invite_expired writer)", () => {
    const d = doc();
    const paths = Object.keys(d.paths ?? {});
    expect(paths.some((p) => p.includes("/invites/{inviteId}/revoke"))).toBe(true);
    expect(d.components?.schemas?.InviteRevoked).toBeDefined();
  });
  it("cookieAuth security scheme 등록(__Host- 세션 쿠키)", () => {
    const schemes = doc().components?.securitySchemes ?? {};
    expect(schemes.cookieAuth).toBeDefined();
    expect((schemes.cookieAuth as { in?: string }).in).toBe("cookie");
  });
  it("Problem 스키마 컴포넌트 등록(RFC 9457)", () => {
    expect(doc().components?.schemas?.Problem).toBeDefined();
  });
  it("앱이 /v1/openapi.json 으로 스펙 직접 서빙(homelab self-host, 인증 불요)", async () => {
    const res = await docApp().request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths ?? {}).some((p) => p.includes("/v1/trips"))).toBe(true);
  });
  it("통화 참조 경로 등록(GET /v1/currencies) + Currency 스키마(minor_unit SSOT)", () => {
    const d = doc();
    const p = (d.paths ?? {})["/v1/currencies"] as Record<string, unknown> | undefined;
    expect(p?.get).toBeDefined();
    const currency = d.components?.schemas?.Currency as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(currency).toBeDefined();
    // iso_exponent는 스키마 어디에도 노출 금지(minor_unit이 SSOT) — 계약 레벨 회귀 락.
    expect(currency?.properties).not.toHaveProperty("iso_exponent");
  });
  it("DELETE /v1/trips/{tripId} 등록 + DeleteTripResult 스키마(방 삭제 계약)", () => {
    const d = doc();
    const p = (d.paths ?? {})["/v1/trips/{tripId}"] as Record<string, unknown> | undefined;
    expect(p?.delete).toBeDefined();
    expect(d.components?.schemas?.DeleteTripResult).toBeDefined();
  });
});
