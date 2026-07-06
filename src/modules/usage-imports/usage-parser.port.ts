import type { UsageDraft } from "./usage-imports.schema.ts";

/** 사용내역 파싱 입력(순수 데이터). referenceDate = 연도 없는 날짜 해석 기준일(YYYY-MM-DD).
 *  tripTimezone·tripStart·tripEnd(YYYY-MM-DD) 있으면 여행 기간 내로 날짜 해석·기간 밖은 confidence 하향. */
export interface UsageParseInput {
  text: string;
  referenceDate: string;
  tripTimezone?: string;
  tripStart?: string;
  tripEnd?: string;
}

/** 사용내역 파싱 포트(어댑터: Claude LLM / 테스트 fake). 무상태 — 초안만 반환, 저장 없음.
 *  동시성 제한이 있는 어댑터(codex)는 parse가 자기보호하며 포화 시 UnavailableError를 throw한다(fail-closed). */
export interface UsageParserPort {
  parse(input: UsageParseInput): Promise<UsageDraft[]>;
}
