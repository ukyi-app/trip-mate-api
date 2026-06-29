import { describe, it, expect } from "vitest";
import {
  memberResponseSchema,
  createInviteSchema,
  acceptResponseSchema,
  updateMemberSchema,
} from "./members.schema.ts";

describe("members/invites DTO", () => {
  it("멤버 응답은 공개 필드만(invite_token_hash 없음)", () => {
    const ok = memberResponseSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      display_name: "철수",
      role: "member",
      status: "joined",
    });
    expect(ok.success).toBe(true);
    expect(
      "invite_token_hash" in
        memberResponseSchema.parse({
          id: "11111111-1111-4111-8111-111111111111",
          display_name: "철수",
          role: "member",
          status: "joined",
          invite_token_hash: "secret",
        }),
    ).toBe(false);
  });
  it("초대 입력은 email·display_name", () => {
    expect(
      createInviteSchema.safeParse({ email: "g@example.com", display_name: "G" }).success,
    ).toBe(true);
    expect(createInviteSchema.safeParse({ email: "bad" }).success).toBe(false);
  });
  it("멤버 수정은 display_name·status(부분), role 없음(admin 양도 제외, finding #4 pass1)", () => {
    expect(updateMemberSchema.safeParse({ display_name: "새이름" }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ status: "deactivated" }).success).toBe(true);
    expect("role" in updateMemberSchema.parse({ display_name: "x", role: "admin" })).toBe(false); // role은 omit/strip
  });
  it("수락 응답은 trip_id·role·status", () => {
    expect(
      acceptResponseSchema.safeParse({ trip_id: "t1", role: "member", status: "joined" }).success,
    ).toBe(true);
  });
});
