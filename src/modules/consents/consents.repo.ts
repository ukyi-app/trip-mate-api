import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userConsents } from "../../db/schema/consents.ts";

export type ConsentType = "tos" | "privacy" | "llm_disclosure";
export type ConsentSource = "signup" | "invite_accept" | "usage_parse" | "settings";

export interface NewConsent {
  user_id: string;
  consent_type: ConsentType;
  document_version: string;
  source: ConsentSource;
  ip?: string;
}
export interface ConsentRecord {
  consent_type: ConsentType;
  document_version: string;
  accepted_at: Date;
}

export interface ConsentRepo {
  // (user_id, consent_type, document_version) 충돌 시 DO NOTHING(재수락 멱등 no-op).
  insertMany(rows: NewConsent[]): Promise<void>;
  listByUser(userId: string): Promise<ConsentRecord[]>;
}

export class DrizzleConsentRepo<T extends Record<string, unknown>> implements ConsentRepo {
  constructor(private readonly db: PostgresJsDatabase<T>) {}

  async insertMany(rows: NewConsent[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(userConsents)
      .values(
        rows.map((r) => ({
          user_id: r.user_id,
          consent_type: r.consent_type,
          document_version: r.document_version,
          source: r.source,
          ...(r.ip ? { ip: r.ip } : {}),
        })),
      )
      .onConflictDoNothing({
        target: [userConsents.user_id, userConsents.consent_type, userConsents.document_version],
      });
  }

  async listByUser(userId: string): Promise<ConsentRecord[]> {
    const rows = await this.db
      .select({
        consent_type: userConsents.consent_type,
        document_version: userConsents.document_version,
        accepted_at: userConsents.accepted_at,
      })
      .from(userConsents)
      .where(eq(userConsents.user_id, userId));
    return rows as ConsentRecord[];
  }
}
