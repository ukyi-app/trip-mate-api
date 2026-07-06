import { describe, it, expect } from "vitest";
import { createMailer, NoopMailer } from "./mailer.resend.ts";

describe("createMailer", () => {
  it("apiKey 없으면 no-op(발송 시도 안 함·에러 없음)", async () => {
    const m = createMailer({ from: "noreply@ukyi.app" });
    expect(m).toBeInstanceOf(NoopMailer);
    await expect(
      m.sendInvite({ to: "a@b.com", inviteUrl: "https://x/invite/t" }),
    ).resolves.toBeUndefined();
  });
  it("apiKey 있으면 ResendMailer(no-op 아님)", () => {
    const m = createMailer({ apiKey: "re_x", from: "noreply@ukyi.app" });
    expect(m).not.toBeInstanceOf(NoopMailer);
  });
});
