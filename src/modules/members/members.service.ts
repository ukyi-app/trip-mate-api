import { ConflictError, ForbiddenError, NotFoundError } from "../../core/errors.ts";
import { generateInviteToken, hashToken, normalizeEmail } from "./domain/invite-token.ts";
import type { MemberRepo, MemberRow, MemberPublic, MemberUpdate } from "./members.repo.ts";

export interface Actor {
  id: string;
  email: string; // 세션 user의 이메일(Better Auth, email_verified 보장)
}
/** 발송용 명령(서비스는 반환만, 실 발송은 caller/후속 — finding #1 pass2). */
export interface InviteCommand {
  token: string; // raw(링크 임베드용)
  link: string; // /invite/{token}
  inviteId: string;
}
interface Opts {
  ttlHours: number;
  now?: () => Date;
}

// drizzle은 postgres 에러를 DrizzleQueryError로 감싸므로 SQLSTATE가 .code 또는 .cause.code에 있다.
const isUniqueViolation = (e: unknown): boolean => {
  const code =
    (e as { code?: string } | null)?.code ??
    (e as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
};

export class MembersService {
  private readonly now: () => Date;
  constructor(
    private readonly repo: MemberRepo,
    private readonly opts: Opts,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private expiry(): Date {
    return new Date(this.now().getTime() + this.opts.ttlHours * 3600_000);
  }

  /** 초대 생성 → **delivery command 반환**(token 항상 반환). 실 발송은 caller가 link로 수행(서비스는 IO 발송 안 함, finding #1 pass2). */
  async createInvite(tripId: string, email: string, displayName: string): Promise<InviteCommand> {
    const { token, hash } = generateInviteToken();
    let row: MemberRow;
    try {
      row = await this.repo.createInvite({
        tripId,
        email,
        hash,
        expiresAt: this.expiry(),
        displayName,
      });
    } catch (e) {
      // uq_member_email(정규화 이메일 중복·이미 멤버)는 사용자 행위 → ConflictError(409)로 매핑(raw 500 방지, finding #3 pass4).
      if (isUniqueViolation(e))
        throw new ConflictError("already invited or a member of this trip", { tripId });
      throw e;
    }
    return { token, link: `/invite/${token}`, inviteId: row.id };
  }

  /** 재발송: tripId 스코핑(교차-trip 차단, finding #1 pass1·pass4) 원자 rotateInviteToken + 새 링크 반환(발송은 caller). */
  async resendInvite(tripId: string, inviteId: string): Promise<InviteCommand> {
    const { token, hash } = generateInviteToken();
    const row = await this.repo.rotateInviteToken(tripId, inviteId, hash, this.expiry());
    if (!row)
      throw new ConflictError("invite not pending or not in this trip", { tripId, inviteId });
    return { token, link: `/invite/${token}`, inviteId };
  }

  /** 초대 취소: 원자 UPDATE(invited→invite_expired). 0행이면 현재 행으로 분기 —
   *  이미 invite_expired면 멱등 no-op(200, 현 상태 반환), 부재면 404, 그 외(joined 등)면 취소불가 409. */
  async revokeInvite(tripId: string, inviteId: string): Promise<MemberRow> {
    const revoked = await this.repo.revokeInvite(tripId, inviteId);
    if (revoked) return revoked;
    const current = await this.repo.findMemberById(tripId, inviteId);
    if (!current) throw new NotFoundError("invite not found", { tripId, inviteId });
    if (current.status === "invite_expired") return current; // 재취소 멱등 no-op
    throw new ConflictError("invite is not pending (already accepted or removed)", {
      tripId,
      inviteId,
      status: current.status,
    });
  }

  async listMembers(tripId: string): Promise<MemberPublic[]> {
    return this.repo.listByTrip(tripId);
  }

  /** 멤버 수정(display_name·status). admin 비활성 시 마지막 어드민 가드(§9.5). 잘못된 전이/부재→Conflict(finding #3 pass3). */
  async updateMember(tripId: string, memberId: string, patch: MemberUpdate): Promise<MemberPublic> {
    if (patch.status === "deactivated" && (await this.repo.isLastActiveAdmin(tripId, memberId))) {
      throw new ForbiddenError("cannot deactivate the last admin", { tripId, memberId });
    }
    const row = await this.repo.updateMember(tripId, memberId, patch);
    if (!row)
      throw new ConflictError("member update not allowed (invalid transition or not found)", {
        tripId,
        memberId,
      });
    return row;
  }

  /** 설계 §3: 토큰→invite, 정규화 이메일 매칭, 원자 CAS. 이미 멤버면 멱등 성공, 경쟁/만료/다른 user면 ConflictError. */
  async acceptInvite(token: string, actor: Actor): Promise<MemberRow> {
    const hash = hashToken(token);
    const invite = await this.repo.findByTokenHash(hash);
    if (!invite) throw new ForbiddenError("invite not found or revoked");
    // 권한 = 정규화 이메일 매칭(토큰은 포인터). 불일치 → 이 trip만 거부(세션 유지, 설계 §3·§5).
    if (invite.normalized_invited_email !== normalizeEmail(actor.email)) {
      throw new ForbiddenError("invite email mismatch", { tripId: invite.trip_id });
    }
    // 이미 이 trip 멤버(다른 행 경유 포함)면 멱등 성공 — uq_member_user raw 위반 방지(finding #3 pass2).
    const existing = await this.repo.findMembership(invite.trip_id, actor.id);
    if (existing && existing.status === "joined") return existing;
    let bound: MemberRow | null;
    try {
      bound = await this.repo.acceptInviteCas({
        inviteId: invite.id,
        userId: actor.id,
        hash,
        normalizedEmail: invite.normalized_invited_email,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // 동시 다른행 바인딩 → 23505 방어
      const m = await this.repo.findMembership(invite.trip_id, actor.id);
      if (m && m.status === "joined") return m;
      throw new ConflictError("invite conflict", { tripId: invite.trip_id });
    }
    if (bound) return bound; // 1행 → 성공
    const after = await this.repo.findMembership(invite.trip_id, actor.id);
    if (after && after.status === "joined") return after; // 멱등(동시 수락·재클릭)
    throw new ConflictError("invite already bound or expired", { tripId: invite.trip_id });
  }

  async ensureCreatorMembership(
    tripId: string,
    userId: string,
    displayName: string,
    email: string,
    tx?: unknown,
  ): Promise<MemberRow> {
    return this.repo.ensureCreatorMembership({ tripId, userId, displayName, email }, tx);
  }

  /** 마지막 어드민 가드(§9.5): 활성 어드민 ≤1이면 강등/비활성 차단. */
  async assertNotLastAdmin(tripId: string): Promise<void> {
    if ((await this.repo.countActiveAdmins(tripId)) <= 1) {
      throw new ForbiddenError("cannot remove the last admin", { tripId });
    }
  }
}
