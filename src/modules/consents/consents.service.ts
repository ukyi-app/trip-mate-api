import { ConflictError } from "../../core/errors.ts";
import { CONSENT_VERSIONS } from "./consents.config.ts";
import type { ConsentRecord, ConsentRepo, ConsentSource, ConsentType } from "./consents.repo.ts";

export interface RecordConsentsInput {
  consents: { type: ConsentType; version: string }[];
  source: Exclude<ConsentSource, "usage_parse">; // usage_parse는 recordDisclosure 전용
  ip?: string;
}

export class ConsentService {
  constructor(private readonly repo: ConsentRepo) {}

  /** tos·privacy 등 batch 수락. 각 버전이 서버 current와 다르면 409(stale). 멱등 기록 후 기록분 반환. */
  async record(userId: string, input: RecordConsentsInput): Promise<ConsentRecord[]> {
    for (const c of input.consents) {
      const expected = CONSENT_VERSIONS[c.type];
      if (c.version !== expected)
        throw new ConflictError("stale consent version", { type: c.type, expected });
    }
    await this.repo.insertMany(
      input.consents.map((c) => ({
        user_id: userId,
        consent_type: c.type,
        document_version: c.version,
        source: input.source,
        ...(input.ip ? { ip: input.ip } : {}),
      })),
    );
    const all = await this.repo.listByUser(userId);
    const wanted = new Set(input.consents.map((c) => `${c.type}:${c.version}`));
    return all.filter((r) => wanted.has(`${r.consent_type}:${r.document_version}`));
  }

  /** 외부 LLM 전송 고지 동의(일회성·버전별). parse가 전송 직전 호출 — 멱등 INSERT(fail-closed: throw 전파). */
  recordDisclosure(userId: string, opts?: { ip?: string }): Promise<void> {
    return this.repo.insertMany([
      {
        user_id: userId,
        consent_type: "llm_disclosure",
        document_version: CONSENT_VERSIONS.llm_disclosure,
        source: "usage_parse",
        ...(opts?.ip ? { ip: opts.ip } : {}),
      },
    ]);
  }

  async list(
    userId: string,
  ): Promise<{ current: typeof CONSENT_VERSIONS; accepted: ConsentRecord[] }> {
    const accepted = await this.repo.listByUser(userId);
    return { current: CONSENT_VERSIONS, accepted };
  }
}
