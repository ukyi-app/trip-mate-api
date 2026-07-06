import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { expenses } from "../../db/schema/expenses.ts";
import type { ReceiptRepo } from "./receipts.service.ts";

/** 영수증 key 매핑(expenses.receipt_object_key). tripId 스코핑으로 교차-trip 접근 차단. */
export class DrizzleReceiptRepo<T extends Record<string, unknown>> implements ReceiptRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  async getReceiptKey(tripId: string, expenseId: string): Promise<string | null | undefined> {
    const rows = await this.db
      .select({ k: expenses.receipt_object_key })
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.trip_id, tripId)));
    if (rows.length === 0) return undefined; // expense 없음(또는 다른 trip)
    return rows[0]!.k; // string | null
  }

  async setReceiptKey(tripId: string, expenseId: string, key: string): Promise<boolean> {
    const res = await this.db
      .update(expenses)
      .set({ receipt_object_key: key })
      .where(and(eq(expenses.id, expenseId), eq(expenses.trip_id, tripId)))
      .returning({ id: expenses.id });
    return res.length > 0;
  }

  async clearReceiptKey(tripId: string, expenseId: string): Promise<void> {
    await this.db
      .update(expenses)
      .set({ receipt_object_key: null })
      .where(and(eq(expenses.id, expenseId), eq(expenses.trip_id, tripId)));
  }
}
