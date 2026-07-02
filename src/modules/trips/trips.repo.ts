import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { trips } from "../../db/schema/trips.ts";
import { tripMembers } from "../../db/schema/members.ts";
import type { CreateTrip, TripResponse, UpdateTrip } from "./trips.schema.ts";

const COLS = {
  id: trips.id,
  title: trips.title,
  start_date: trips.start_date,
  end_date: trips.end_date,
  destination_countries: trips.destination_countries,
  timezone: trips.timezone,
  primary_local_currency: trips.primary_local_currency,
  settlement_currency: trips.settlement_currency,
  settlement_status: trips.settlement_status,
};

export interface TripRepo {
  create(input: CreateTrip, userId: string, tx?: unknown): Promise<TripResponse>;
  findById(id: string): Promise<TripResponse | null>;
  listForUser(userId: string): Promise<TripResponse[]>;
  update(id: string, patch: UpdateTrip): Promise<TripResponse | null>;
  // (F5) 삭제는 호출자 admin 재검증까지 원자로 — 반환: "deleted" | "not_found" | "forbidden".
  delete(
    tripId: string,
    callerMembershipId: string,
    tx?: unknown,
  ): Promise<"deleted" | "not_found" | "forbidden">;
}

export class DrizzleTripRepo<T extends Record<string, unknown>> implements TripRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  // tx 핸들 주입 시 그 위에서 실행(trip 생성+멤버십 단일 tx, finding #2 pass1)
  async create(input: CreateTrip, userId: string, tx?: unknown): Promise<TripResponse> {
    const exec = (tx as PostgresJsDatabase<T> | undefined) ?? this.db;
    const rows = await exec
      .insert(trips)
      .values({ ...input, created_by_user_id: userId })
      .returning(COLS);
    return rows[0]! as TripResponse;
  }
  async findById(id: string): Promise<TripResponse | null> {
    const rows = await this.db.select(COLS).from(trips).where(eq(trips.id, id));
    return (rows[0] ?? null) as TripResponse | null;
  }
  async listForUser(userId: string): Promise<TripResponse[]> {
    const rows = await this.db
      .select(COLS)
      .from(trips)
      .innerJoin(tripMembers, eq(tripMembers.trip_id, trips.id))
      .where(and(eq(tripMembers.user_id, userId), eq(tripMembers.status, "joined")));
    return rows as TripResponse[];
  }
  async update(id: string, patch: UpdateTrip): Promise<TripResponse | null> {
    if (Object.keys(patch).length === 0) return this.findById(id);
    const rows = await this.db.update(trips).set(patch).where(eq(trips.id, id)).returning(COLS);
    return (rows[0] ?? null) as TripResponse | null;
  }

  // 어드민 방 전체 삭제(무가드): trip row FOR UPDATE로 finalize/expense-create·동시 양도와 직렬화.
  // (F5) 미들웨어 통과 후 강등/비활성됐을 수 있으므로 잠금 하에서 호출자 admin 여부를 재검증(TOCTOU 차단).
  // (F7) tx 미제공 시 내부에서 트랜잭션을 열어 FOR UPDATE→DELETE 원자성 강제(락 조기 해제 방지).
  // 자식(members/expenses/…)은 FK onDelete cascade로 자동 정리. trips에 version/deleted_at 없음.
  async delete(
    tripId: string,
    callerMembershipId: string,
    tx?: unknown,
  ): Promise<"deleted" | "not_found" | "forbidden"> {
    const run = async (
      exec: PostgresJsDatabase<T>,
    ): Promise<"deleted" | "not_found" | "forbidden"> => {
      const locked = await exec
        .select({ id: trips.id })
        .from(trips)
        .where(eq(trips.id, tripId))
        .for("update");
      if (locked.length === 0) return "not_found";
      const admin = await exec
        .select({ id: tripMembers.id })
        .from(tripMembers)
        .where(
          and(
            eq(tripMembers.trip_id, tripId),
            eq(tripMembers.id, callerMembershipId),
            eq(tripMembers.role, "admin"),
            eq(tripMembers.status, "joined"),
          ),
        );
      if (admin.length === 0) return "forbidden";
      await exec.delete(trips).where(eq(trips.id, tripId));
      return "deleted";
    };
    // tx 있으면 그 위에서, 없으면 내부 tx로(F7: 항상 원자 — 옵션 fallback로 락이 조기 해제되지 않게).
    return tx ? run(tx as PostgresJsDatabase<T>) : this.db.transaction(run);
  }
}
