import { describe, it, expect } from "vitest";
import { normalizeEmail, generateInviteToken, hashToken } from "./invite-token.ts";

describe("normalizeEmail (§8.5)", () => {
  it("소문자·trim", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });
  it("gmail 점 제거 + plus 태그 제거", () => {
    expect(normalizeEmail("john.doe+trip@gmail.com")).toBe("johndoe@gmail.com");
    expect(normalizeEmail("J.O.H.N+x.y@googlemail.com")).toBe("john@googlemail.com");
  });
  it("비-gmail은 점·+태그 보존(canonicalize 안 함, finding #2)", () => {
    expect(normalizeEmail("A.b+Tag@outlook.com")).toBe("a.b+tag@outlook.com"); // lowercase·trim만, +/점 보존
    expect(normalizeEmail("a+x@example.com")).not.toBe(normalizeEmail("a@example.com")); // 별개 principal 유지
  });
  it("@ 없으면 ValidationError", () => {
    expect(() => normalizeEmail("nope")).toThrow();
  });
});

describe("generateInviteToken / hashToken", () => {
  it("토큰은 base64url, hash는 sha256 hex 64자, 결정적", () => {
    const { token, hash } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32바이트 base64url(패딩 없음)
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash); // hash(token)==저장 hash
  });
  it("매 호출 고유 토큰", () => {
    expect(generateInviteToken().token).not.toBe(generateInviteToken().token);
  });
});
