import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tripFxDefaults } from "../../db/schema/fx.ts";
import type { TripDefaultsPort } from "./fx.types.ts";

export class DrizzleTripDefaults<T extends Record<string, unknown>> implements TripDefaultsPort {
  constructor(private readonly db: PostgresJsDatabase<T>) {}
  async getRate(tripId: string, base: string, settlement: string): Promise<string | null> {
    const rows = await this.db
      .select({ rate: tripFxDefaults.rate })
      .from(tripFxDefaults)
      .where(
        and(
          eq(tripFxDefaults.trip_id, tripId),
          eq(tripFxDefaults.base_currency, base),
          eq(tripFxDefaults.settlement_currency, settlement),
        ),
      );
    return rows[0]?.rate ?? null;
  }
  async upsertRate(tripId: string, base: string, settlement: string, rate: string): Promise<void> {
    await this.db
      .insert(tripFxDefaults)
      .values({ trip_id: tripId, base_currency: base, settlement_currency: settlement, rate })
      .onConflictDoUpdate({
        target: [
          tripFxDefaults.trip_id,
          tripFxDefaults.base_currency,
          tripFxDefaults.settlement_currency,
        ],
        set: { rate },
      });
  }
}
