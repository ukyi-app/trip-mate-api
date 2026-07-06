import type { InviteEmail } from "./mailer.port.ts";

export interface RenderedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

// HTML 이스케이프 — 이메일 본문에 user 값(trip/inviter명) 주입 시 마크업 차단.
const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** 초대 이메일 렌더(순수). tripName/inviterName은 HTML 이스케이프. */
export function renderInviteEmail(msg: InviteEmail, from: string): RenderedEmail {
  const trip = msg.tripName ?? "여행";
  const inviter = msg.inviterName ? `${msg.inviterName}님이 ` : "";
  const subject = `${trip} 정산에 초대되었습니다`;
  const text = `${inviter}${trip} 정산에 초대했습니다.\n\n초대 수락: ${msg.inviteUrl}\n\n링크는 만료될 수 있습니다.`;
  const eInviter = msg.inviterName ? `${escapeHtml(msg.inviterName)}님이 ` : "";
  const html =
    `<p>${eInviter}<strong>${escapeHtml(trip)}</strong> 정산에 초대했습니다.</p>` +
    `<p><a href="${escapeHtml(msg.inviteUrl)}">초대 수락하기</a></p>` +
    `<p>${escapeHtml(msg.inviteUrl)}</p>`;
  return { from, to: msg.to, subject, html, text };
}
