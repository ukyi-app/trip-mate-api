import { ofetch } from "ofetch";
import type { Mailer, InviteEmail } from "./mailer.port.ts";
import { renderInviteEmail } from "./invite-email.ts";

/** RESEND_API_KEY 미설정 시 어댑터 — 발송하지 않음(로컬·graceful). */
export class NoopMailer implements Mailer {
  async sendInvite(): Promise<void> {}
}

/** Resend HTTP API 어댑터. 실패는 로깅 후 rethrow(호출자 best-effort). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly onError?: (e: unknown) => void,
  ) {}
  async sendInvite(msg: InviteEmail): Promise<void> {
    const email = renderInviteEmail(msg, this.from);
    try {
      await ofetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          from: email.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
      });
    } catch (e) {
      this.onError?.(e);
      throw e;
    }
  }
}

export interface MailerConfig {
  apiKey?: string;
  from: string;
  onError?: (e: unknown) => void;
}
/** apiKey 있으면 ResendMailer, 없으면 NoopMailer. */
export function createMailer(cfg: MailerConfig): Mailer {
  return cfg.apiKey ? new ResendMailer(cfg.apiKey, cfg.from, cfg.onError) : new NoopMailer();
}
