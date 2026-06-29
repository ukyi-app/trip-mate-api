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
}
