import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripMembers } from "../../db/schema/members.ts";
import { normalizeEmail } from "./domain/invite-token.ts";
import { ConflictError } from "../../core/errors.ts";

/** 공개 멤버 응답 행(display_name 포함, 내부 컬럼 제외). role/status는 enum(응답 DTO·DB select와 정합). */
export interface MemberPublic {
  id: string;
  display_name: string;
  role: "admin" | "member";
  status: "invited" | "joined" | "deactivated" | "invite_expired";
}
export interface MemberUpdate {
  // | undefined 명시: zod .partial() valid 출력과 exactOptionalPropertyTypes 정합(컨트롤러 캐스트 회피).
  display_name?: string | undefined;
  status?: "joined" | "deactivated" | undefined;
}

export interface MemberRow {
  id: string;
  trip_id: string;
  user_id: string | null;
  normalized_invited_email: string;
  role: string;
  status: string;
}
export interface CreateInviteInput {
  tripId: string;
  email: string;
  hash: string;
  expiresAt: Date;
  displayName: string;
}
export interface AcceptCasInput {
  inviteId: string;
  userId: string;
  hash: string;
  normalizedEmail: string;
}
export interface MemberRepo {
  createInvite(i: CreateInviteInput): Promise<MemberRow>;
  findByTokenHash(hash: string): Promise<MemberRow | null>;
  acceptInviteCas(i: AcceptCasInput): Promise<MemberRow | null>;
  /** 재발송 회전 — **tripId 스코핑**(교차-trip 회전 차단, finding #1 pass1·pass4). 0행=비-pending/타-trip. */
  rotateInviteToken(
    tripId: string,
    inviteId: string,
    hash: string,
    expiresAt: Date,
  ): Promise<MemberRow | null>;
  findMembership(tripId: string, userId: string): Promise<MemberRow | null>;
  listByTrip(tripId: string): Promise<MemberPublic[]>;
  /** 멤버 수정 — status는 **user_id 바인딩된 joined↔deactivated만**(invited→joined 위조 차단, finding #3 pass3). 0행=불가/부재. */
  updateMember(tripId: string, memberId: string, patch: MemberUpdate): Promise<MemberPublic | null>;
  isLastActiveAdmin(tripId: string, memberId: string): Promise<boolean>;
  countActiveAdmins(tripId: string): Promise<number>;
  ensureCreatorMembership(
    i: { tripId: string; userId: string; displayName: string; email: string },
    tx?: unknown,
  ): Promise<MemberRow>;
}

const COLS = {
  id: tripMembers.id,
  trip_id: tripMembers.trip_id,
  user_id: tripMembers.user_id,
  normalized_invited_email: tripMembers.normalized_invited_email,
  role: tripMembers.role,
  status: tripMembers.status,
};

const PUBLIC_COLS = {
  id: tripMembers.id,
  display_name: tripMembers.display_name,
  role: tripMembers.role,
  status: tripMembers.status,
};

export class DrizzleMemberRepo<T extends Record<string, unknown>> implements MemberRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  async createInvite(i: CreateInviteInput): Promise<MemberRow> {
    const norm = normalizeEmail(i.email);
    const rows = await this.db
      .insert(tripMembers)
      .values({
        trip_id: i.tripId,
        invited_email: i.email,
        normalized_invited_email: norm,
        invite_token_hash: i.hash,
        invite_token_expires_at: i.expiresAt,
        display_name: i.displayName,
        role: "member",
        status: "invited",
      })
      .returning(COLS);
    return rows[0]!;
  }

  async findByTokenHash(hash: string): Promise<MemberRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(tripMembers)
      .where(eq(tripMembers.invite_token_hash, hash));
    return rows[0] ?? null;
  }

  /** 원자 CAS: 검증 predicate 전부 WHERE에 포함(TOCTOU 제거, 설계 §3·pass3·4·5). 1행=성공·0행=경쟁/이미바인딩. */
  async acceptInviteCas(i: AcceptCasInput): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({ user_id: i.userId, status: "joined", joined_at: new Date() })
      .where(
        and(
          eq(tripMembers.id, i.inviteId),
          eq(tripMembers.status, "invited"),
          isNull(tripMembers.user_id),
          eq(tripMembers.invite_token_hash, i.hash),
          eq(tripMembers.normalized_invited_email, i.normalizedEmail),
          sql`${tripMembers.invite_token_expires_at} > now()`,
        ),
      )
      .returning(COLS);
    return rows[0] ?? null;
  }

  /** 원자 재발송: 단일 UPDATE로 hash·expires 교체(trip_id·id·status='invited' 가드). 0행=비-pending/타-trip(finding #1 pass1·pass4·#3). */
  async rotateInviteToken(
    tripId: string,
    inviteId: string,
    hash: string,
    expiresAt: Date,
  ): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({ invite_token_hash: hash, invite_token_expires_at: expiresAt })
      .where(
        and(
          eq(tripMembers.trip_id, tripId),
          eq(tripMembers.id, inviteId),
          eq(tripMembers.status, "invited"),
        ),
      )
      .returning(COLS);
    return rows[0] ?? null;
  }

  async listByTrip(tripId: string): Promise<MemberPublic[]> {
    return this.db.select(PUBLIC_COLS).from(tripMembers).where(eq(tripMembers.trip_id, tripId));
  }

  /** 멤버 수정. status 변경은 user_id 바인딩된 joined↔deactivated만(invited→joined 위조 차단, finding #3 pass3). */
  async updateMember(
    tripId: string,
    memberId: string,
    patch: MemberUpdate,
  ): Promise<MemberPublic | null> {
    const set: { display_name?: string; status?: "joined" | "deactivated" } = {};
    if (patch.display_name !== undefined) set.display_name = patch.display_name;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) {
      const cur = await this.db
        .select(PUBLIC_COLS)
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)));
      return cur[0] ?? null;
    }
    const conds = [eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)];
    if (patch.status !== undefined) {
      // 전이 제약: 바인딩된 멤버의 joined↔deactivated만
      conds.push(isNotNull(tripMembers.user_id));
      conds.push(inArray(tripMembers.status, ["joined", "deactivated"]));
    }
    const rows = await this.db
      .update(tripMembers)
      .set(set)
      .where(and(...conds))
      .returning(PUBLIC_COLS);
    return rows[0] ?? null;
  }

  /** memberId가 그 trip의 **유일한 활성 어드민**인지(비활성 차단용, §9.5). */
  async isLastActiveAdmin(tripId: string, memberId: string): Promise<boolean> {
    const admins = await this.db
      .select({ id: tripMembers.id })
      .from(tripMembers)
      .where(
        and(
          eq(tripMembers.trip_id, tripId),
          eq(tripMembers.role, "admin"),
          eq(tripMembers.status, "joined"),
        ),
      );
    return admins.length === 1 && admins[0]?.id === memberId;
  }

  async findMembership(tripId: string, userId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.user_id, userId)));
    return rows[0] ?? null;
  }

  async countActiveAdmins(tripId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tripMembers)
      .where(
        and(
          eq(tripMembers.trip_id, tripId),
          eq(tripMembers.role, "admin"),
          eq(tripMembers.status, "joined"),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** 어드민 자동 멤버십(생성자 첫 로그인). **원자 멱등**(finding #4): onConflictDoNothing 후 재read.
   *  tx 주입 시 그 위에서 실행(trip 생성과 단일 tx — tx 내 inserted row 가시성, finding #2 pass1·pass2). */
  async ensureCreatorMembership(
    i: { tripId: string; userId: string; displayName: string; email: string },
    tx?: unknown,
  ): Promise<MemberRow> {
    const exec = (tx as PostgresJsDatabase<T> | undefined) ?? this.db;
    await exec
      .insert(tripMembers)
      .values({
        trip_id: i.tripId,
        user_id: i.userId,
        invited_email: i.email,
        normalized_invited_email: normalizeEmail(i.email),
        display_name: i.displayName,
        role: "admin",
        status: "joined",
        joined_at: new Date(),
      })
      .onConflictDoNothing(); // uq_member_user(trip_id,user_id) 또는 uq_member_email 충돌 시 no-op
    const rows = await exec
      .select(COLS)
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, i.tripId), eq(tripMembers.user_id, i.userId)));
    const row = rows[0] ?? null;
    if (!row) throw new ConflictError("failed to ensure creator membership", { tripId: i.tripId });
    return row;
  }
}
