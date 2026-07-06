import { describe, it, expect } from "vitest";
import { renderInviteEmail } from "./invite-email.ts";

describe("renderInviteEmail (순수)", () => {
  it("수신자·발신자·제목·URL 구성", () => {
    const r = renderInviteEmail(
      {
        to: "a@b.com",
        inviteUrl: "https://trip-mate.ukyi.app/invite/tok123",
        tripName: "제주여행",
        inviterName: "철수",
      },
      "noreply@ukyi.app",
    );
    expect(r.to).toBe("a@b.com");
    expect(r.from).toBe("noreply@ukyi.app");
    expect(r.subject).toContain("제주여행");
    expect(r.html).toContain("https://trip-mate.ukyi.app/invite/tok123");
    expect(r.text).toContain("https://trip-mate.ukyi.app/invite/tok123");
    expect(r.text).toContain("철수");
  });

  it("tripName 없으면 기본 문구", () => {
    const r = renderInviteEmail({ to: "a@b.com", inviteUrl: "https://x/invite/t" }, "f@x");
    expect(r.subject).toContain("여행");
  });

  it("HTML 이스케이프 — tripName의 마크업 주입 차단(보안)", () => {
    const r = renderInviteEmail(
      { to: "a@b.com", inviteUrl: "https://x/invite/t", tripName: "<script>alert(1)</script>" },
      "f@x",
    );
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });
});
