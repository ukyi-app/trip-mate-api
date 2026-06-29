import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "../../../core/errors.ts";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** §8.5(하드닝, finding #2): 소문자·trim. **Gmail 계열만** local part의 '.'·'+태그' canonicalize.
 *  비-Gmail은 '+태그'·'.'이 별개 mailbox/principal일 수 있어 **보존**한다 — 토큰 유출 시 `a@dom`이
 *  `a+trip@dom` 초대를 매칭하는 것을 차단(토큰=포인터 모델 유지). 모든 도메인 일괄 '+' 제거는 금지. */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) throw new ValidationError(`invalid email: ${raw}`);
  const domain = trimmed.slice(at + 1);
  let local = trimmed.slice(0, at);
  if (GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll(".", "");
  }
  if (!local) throw new ValidationError(`invalid email local part: ${raw}`);
  return `${local}@${domain}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 링크용 raw 토큰(base64url, 패딩 없음) + DB 저장용 sha256 hash. */
export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
