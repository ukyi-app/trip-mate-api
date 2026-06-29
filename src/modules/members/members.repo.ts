import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripMembers } from "../../db/schema/members.ts";
import { normalizeEmail } from "./domain/invite-token.ts";
import { ConflictError } from "../../core/errors.ts";

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
  rotateInviteToken(inviteId: string, hash: string, expiresAt: Date): Promise<MemberRow | null>;
  findMembership(tripId: string, userId: string): Promise<MemberRow | null>;
  countActiveAdmins(tripId: string): Promise<number>;
  ensureCreatorMembership(i: {
    tripId: string;
    userId: string;
    displayName: string;
    email: string;
  }): Promise<MemberRow>;
}

const COLS = {
  id: tripMembers.id,
  trip_id: tripMembers.trip_id,
  user_id: tripMembers.user_id,
  normalized_invited_email: tripMembers.normalized_invited_email,
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

  /** 원자 재발송: 단일 UPDATE로 hash·expires 동시 교체(status='invited' 가드). 1행=성공·0행=비-pending. finding #3. */
  async rotateInviteToken(
    inviteId: string,
    hash: string,
    expiresAt: Date,
  ): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({ invite_token_hash: hash, invite_token_expires_at: expiresAt })
      .where(and(eq(tripMembers.id, inviteId), eq(tripMembers.status, "invited")))
      .returning(COLS);
    return rows[0] ?? null;
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

  /** 어드민 자동 멤버십(생성자 첫 로그인). **원자 멱등**(finding #4): onConflictDoNothing 후 재read. */
  async ensureCreatorMembership(i: {
    tripId: string;
    userId: string;
    displayName: string;
    email: string;
  }): Promise<MemberRow> {
    await this.db
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
    const row = await this.findMembership(i.tripId, i.userId);
    if (!row) throw new ConflictError("failed to ensure creator membership", { tripId: i.tripId });
    return row;
  }
}
