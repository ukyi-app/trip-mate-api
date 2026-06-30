import { ValidationError } from "../../core/errors.ts";

// 지출 목록 keyset 커서: 마지막 행의 (spent_at, id)를 base64url로 인코딩(api-contract §6).
// 정렬 (spent_at desc, id desc) — 불변 id 타이브레이커로 중복/누락 방지.
export interface ExpenseCursor {
  spentAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 4자리 연도 canonical ISO만 수용. 확장연도(±YYYYYY)는 toISOString 왕복은 통과하나
// Postgres timestamptz 파서가 거부(22009) → 미처리 500. 여기서 422로 선차단.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEP = "|"; // ISO 타임스탬프·UUID 어느 쪽에도 없는 구분자

/** (spent_at, id) → 불투명 base64url 토큰. spent_at은 canonical ISO(ms)로 무손실. */
export function encodeCursor(row: { spent_at: Date; id: string }): string {
  return Buffer.from(`${row.spent_at.toISOString()}${SEP}${row.id}`, "utf8").toString("base64url");
}

/** 토큰 → {spentAt, id}. 형식/구조/값 검증 실패 시 ValidationError(422, api-contract §6). */
export function decodeCursor(raw: string): ExpenseCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split(SEP);
  if (parts.length !== 2) throw new ValidationError("invalid cursor");
  const [iso, id] = parts as [string, string];
  if (!UUID.test(id)) throw new ValidationError("invalid cursor");
  const spentAt = new Date(iso);
  // 포맷 고정(4자리 연도) + toISOString 왕복 일치로 canonical ISO만 수용(Date의 관대한 파싱·확장연도 차단)
  if (!ISO.test(iso) || Number.isNaN(spentAt.getTime()) || spentAt.toISOString() !== iso)
    throw new ValidationError("invalid cursor");
  return { spentAt, id };
}
