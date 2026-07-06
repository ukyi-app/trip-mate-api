import type { UsageDraft } from "./usage-imports.schema.ts";

export interface TripWindow {
  tripTimezone?: string;
  tripStart?: string; // YYYY-MM-DD
  tripEnd?: string; // YYYY-MM-DD
}

/** spent_at의 여행-로컬 날짜(tripTimezone, 없으면 KST). 잘못된 tz는 KST 폴백. */
function localDate(spentAt: string, timezone: string | undefined): string | null {
  const d = new Date(spentAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "Asia/Seoul" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
  }
}

/** LLM 출력 결정적 후검증(슬라이스1 리뷰): 여행 기간 밖 spent_at은 confidence를 cap 이하로 강하게 낮춘다.
 *  거부하지 않는다 — FE 확인 단계가 최종 방어이고 여행 전 예약 등 정당 경계 케이스가 있다. 기간 미제공이면 무검증. */
export function clampOutOfWindowConfidence(
  drafts: UsageDraft[],
  window: TripWindow,
  cap = 0.3,
): UsageDraft[] {
  const { tripStart, tripEnd, tripTimezone } = window;
  if (!tripStart || !tripEnd) return drafts;
  return drafts.map((d) => {
    const day = localDate(d.spent_at, tripTimezone);
    if (day === null) return d; // spent_at 파싱 불가 시 손대지 않음(스키마가 이미 ISO 보장)
    const outOfWindow = day < tripStart || day > tripEnd; // YYYY-MM-DD 사전식 비교
    return outOfWindow && d.confidence > cap ? { ...d, confidence: cap } : d;
  });
}
