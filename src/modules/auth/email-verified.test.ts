import { describe, it, expect } from "vitest";
import { assertGoogleEmailVerified, type GoogleProfileLike } from "./email-verified.ts";
import { ForbiddenError } from "../../core/errors.ts";

const p = (over: Partial<GoogleProfileLike> = {}): GoogleProfileLike => ({
  email: "u@gmail.com",
  email_verified: true,
  ...over,
});

describe("assertGoogleEmailVerified (§34.4)", () => {
  it("verified=true → 통과(프로필 반환)", () => {
    expect(assertGoogleEmailVerified(p()).email).toBe("u@gmail.com");
  });
  it("verified=false → ForbiddenError", () => {
    expect(() => assertGoogleEmailVerified(p({ email_verified: false }))).toThrow(ForbiddenError);
  });
  it("verified 누락 → ForbiddenError(미검증 취급)", () => {
    expect(() => assertGoogleEmailVerified({ email: "u@gmail.com" })).toThrow(ForbiddenError);
  });
});
