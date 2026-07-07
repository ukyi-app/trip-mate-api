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

/** 사용내역 이미지(영수증·앱 스크린샷). 텍스트 대신 비전 입력으로 초안 추출. */
export interface UsageImage {
  bytes: Uint8Array;
  contentType: string; // image/jpeg·png·webp·heic 등
}

/** 이미지 파싱 입력 — 텍스트가 없으므로 UsageParseInput에서 text 제외(기준일·여행 기간만). */
export type UsageImageParseInput = Omit<UsageParseInput, "text">;

/** 사용내역 파싱 포트(어댑터: Codex CLI / Claude LLM / 테스트 fake). 무상태 — 초안만 반환, 저장 없음.
 *  동시성 제한이 있는 어댑터(codex)는 parse가 자기보호하며 포화 시 UnavailableError를 throw한다(fail-closed).
 *  parseImage는 선택 — 미구현 어댑터/미주입 시 이미지 라우트는 503(graceful off). */
export interface UsageParserPort {
  parse(input: UsageParseInput): Promise<UsageDraft[]>;
  parseImage?(input: UsageImageParseInput, image: UsageImage): Promise<UsageDraft[]>;
}
