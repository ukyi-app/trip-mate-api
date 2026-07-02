import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripMembers } from "../../db/schema/members.ts";
import { trips } from "../../db/schema/trips.ts";
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

/** 어드민 양도 결과. 실패는 서비스가 HTTP 에러로 매핑(not_admin→409, target_missing→404, target_ineligible→409). */
export type TransferAdminOutcome =
  | { ok: true; member: MemberPublic }
  | { ok: false; reason: "not_admin" | "target_missing" | "target_ineligible" };

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
  createInvite(i: CreateInviteInput): Promise<MemberRow | null>;
  findByTokenHash(hash: string): Promise<MemberRow | null>;
  acceptInviteCas(i: AcceptCasInput): Promise<MemberRow | null>;
  /** 재발송 회전 — **tripId 스코핑**(교차-trip 회전 차단, finding #1 pass1·pass4). 0행=비-pending/타-trip. */
  rotateInviteToken(
    tripId: string,
    inviteId: string,
    hash: string,
    expiresAt: Date,
  ): Promise<MemberRow | null>;
  /** pending(invited) 초대 취소 — 단일 원자 UPDATE로 invite_expired 전이·토큰 null화. tripId 스코핑, 0행=비-pending/타-trip. */
  revokeInvite(tripId: string, inviteId: string): Promise<MemberRow | null>;
  /** (tripId, memberId) 단건 조회 — revoke 0행 시 상태 분기(멱등/409/404)용. */
  findMemberById(tripId: string, memberId: string): Promise<MemberRow | null>;
  findMembership(tripId: string, userId: string): Promise<MemberRow | null>;
  listByTrip(tripId: string): Promise<MemberPublic[]>;
  /** 멤버 수정 — status는 **user_id 바인딩된 joined↔deactivated만**. 비활성은 trip 락 하 last-admin 재검증(F6). 0행=불가/부재, "last_admin"=마지막 admin 비활성 차단. */
  updateMember(
    tripId: string,
    memberId: string,
    patch: MemberUpdate,
  ): Promise<MemberPublic | null | "last_admin">;
  isLastActiveAdmin(tripId: string, memberId: string): Promise<boolean>;
  countActiveAdmins(tripId: string): Promise<number>;
  /** 어드민 원자 양도 — trip row FOR UPDATE 하 강등 선행→승격 후행(uq_one_admin non-deferrable, 역순 시 순간 2 admin 위반). */
  transferAdmin(
    tripId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<TransferAdminOutcome>;
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

  /** 초대 생성(revive-upsert): 신규는 INSERT, 같은 (trip_id, 정규화 이메일)이 invite_expired(취소) 또는 시간만료(invited+토큰 만료)면 재INSERT 대신 revive(status=invited·새 hash/expires·name/email 갱신).
   *  FULL uq_member_email이 재INSERT를 23505로 막으므로 ON CONFLICT DO UPDATE로 원자 처리. setWhere가 false(활성 invited/joined/deactivated)면 0행 → service가 409로 매핑. */
  async createInvite(i: CreateInviteInput): Promise<MemberRow | null> {
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
      .onConflictDoUpdate({
        target: [tripMembers.trip_id, tripMembers.normalized_invited_email], // = uq_member_email
        set: {
          invited_email: i.email,
          invite_token_hash: i.hash,
          invite_token_expires_at: i.expiresAt,
          display_name: i.displayName,
          status: "invited",
        },
        // F2 반영: 취소(invite_expired) + 시간만료(status='invited'이나 토큰 만료 — 시간만료는 status를 바꾸지 않으므로 이 조건 필수) 둘 다 revive.
        setWhere: sql`${tripMembers.status} = 'invite_expired' OR (${tripMembers.status} = 'invited' AND ${tripMembers.invite_token_expires_at} <= now())`,
      })
      .returning(COLS);
    return rows[0] ?? null; // 0행 = 활성 초대/멤버 이미 존재(revive 불가)
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

  /** 초대 취소: 단일 원자 UPDATE(status='invite_expired', 토큰 null화). trip_id·id·status='invited' 가드로 tripId 스코핑·멱등성 확보. 0행=비-pending/타-trip. */
  async revokeInvite(tripId: string, inviteId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .update(tripMembers)
      .set({
        status: "invite_expired",
        invite_token_hash: null,
        invite_token_expires_at: null,
      })
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

  async findMemberById(tripId: string, memberId: string): Promise<MemberRow | null> {
    const rows = await this.db
      .select(COLS)
      .from(tripMembers)
      .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)));
    return rows[0] ?? null;
  }

  async listByTrip(tripId: string): Promise<MemberPublic[]> {
    return this.db.select(PUBLIC_COLS).from(tripMembers).where(eq(tripMembers.trip_id, tripId));
  }

  /** 멤버 수정. status 변경은 user_id 바인딩된 joined↔deactivated만(invited→joined 위조 차단, finding #3 pass3).
   *  (F6) 비활성 전이는 trip 락 하 원자로 — 양도의 동시 승격과 직렬화해 last-admin 재검증이 stale하지 않게. */
  async updateMember(
    tripId: string,
    memberId: string,
    patch: MemberUpdate,
  ): Promise<MemberPublic | null | "last_admin"> {
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
    // 비활성: trip 락 하 재검증(F6). 마지막 활성 admin이면 차단(0 admin 방지).
    if (patch.status === "deactivated") {
      return this.db.transaction(async (tx): Promise<MemberPublic | null | "last_admin"> => {
        await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).for("update");
        const admins = await tx
          .select({ id: tripMembers.id })
          .from(tripMembers)
          .where(
            and(
              eq(tripMembers.trip_id, tripId),
              eq(tripMembers.role, "admin"),
              eq(tripMembers.status, "joined"),
            ),
          );
        if (admins.length === 1 && admins[0]?.id === memberId) return "last_admin" as const;
        const rows = await tx
          .update(tripMembers)
          .set(set)
          .where(
            and(
              eq(tripMembers.trip_id, tripId),
              eq(tripMembers.id, memberId),
              isNotNull(tripMembers.user_id),
              inArray(tripMembers.status, ["joined", "deactivated"]),
            ),
          )
          .returning(PUBLIC_COLS);
        return rows[0] ?? null;
      });
    }
    // display_name·joined 전이는 단문(락 불요).
    const conds = [eq(tripMembers.trip_id, tripId), eq(tripMembers.id, memberId)];
    if (patch.status !== undefined) {
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

  /** ④ 어드민 양도: 단일 tx + trip row FOR UPDATE(동일 trip 동시 양도 직렬화, trip_members엔 version 없음).
   *  적격성은 잠금 하 read로 판정(실패 시 무-쓰기 → 커밋해도 무해), 쓰기는 강등→승격 순서 강제 + CAS WHERE로
   *  TOCTOU 제거. CAS 0행은 잠금 하 재검증 실패(경쟁)이므로 throw → 강등 롤백(원자성). */
  async transferAdmin(
    tripId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<TransferAdminOutcome> {
    return this.db.transaction(async (tx): Promise<TransferAdminOutcome> => {
      await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).for("update");

      const [from] = await tx
        .select({ role: tripMembers.role, status: tripMembers.status })
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, fromMemberId)));
      if (!from || from.role !== "admin" || from.status !== "joined")
        return { ok: false, reason: "not_admin" };

      const [to] = await tx
        .select({
          role: tripMembers.role,
          status: tripMembers.status,
          user_id: tripMembers.user_id,
        })
        .from(tripMembers)
        .where(and(eq(tripMembers.trip_id, tripId), eq(tripMembers.id, toMemberId)));
      if (!to) return { ok: false, reason: "target_missing" };
      if (
        to.status !== "joined" ||
        to.user_id === null ||
        to.role !== "member" ||
        toMemberId === fromMemberId
      )
        return { ok: false, reason: "target_ineligible" };

      // (1) 강등 선행 — CAS WHERE(role='admin' AND status='joined')
      const demoted = await tx
        .update(tripMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, fromMemberId),
            eq(tripMembers.role, "admin"),
            eq(tripMembers.status, "joined"),
          ),
        )
        .returning({ id: tripMembers.id });
      if (demoted.length === 0)
        throw new ConflictError("admin transfer race: caller no longer admin", {
          tripId,
          fromMemberId,
        });

      // (2) 승격 후행 — CAS WHERE(joined·bound·member·≠from)
      const promoted = await tx
        .update(tripMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, toMemberId),
            eq(tripMembers.status, "joined"),
            isNotNull(tripMembers.user_id),
            eq(tripMembers.role, "member"),
            ne(tripMembers.id, fromMemberId),
          ),
        )
        .returning(PUBLIC_COLS);
      if (promoted.length === 0)
        throw new ConflictError("admin transfer race: target no longer eligible", {
          tripId,
          toMemberId,
        });

      return { ok: true, member: promoted[0]! };
    });
  }
}
