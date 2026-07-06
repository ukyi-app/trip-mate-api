/** 초대 이메일 발송 명령. */
export interface InviteEmail {
  to: string; // 초대받는 이메일
  inviteUrl: string; // 절대 URL (https://<fe>/invite/{token})
  tripName?: string;
  inviterName?: string;
}

/** 이메일 발송 포트(어댑터: Resend / no-op). 실패는 어댑터/호출자가 best-effort 처리. */
export interface Mailer {
  sendInvite(msg: InviteEmail): Promise<void>;
}
