import type { UsageDraft } from "./usage-imports.schema.ts";

/** 사용내역 파싱 입력(순수 데이터). referenceDate = 연도 없는 날짜 해석 기준일(YYYY-MM-DD). */
export interface UsageParseInput {
  text: string;
  referenceDate: string;
}

/** 사용내역 파싱 포트(어댑터: Claude LLM / 테스트 fake). 무상태 — 초안만 반환, 저장 없음. */
export interface UsageParserPort {
  parse(input: UsageParseInput): Promise<UsageDraft[]>;
}
