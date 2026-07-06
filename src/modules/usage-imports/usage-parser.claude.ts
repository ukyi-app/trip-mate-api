import Anthropic from "@anthropic-ai/sdk";
import { z } from "@hono/zod-openapi";
import { UpstreamError } from "../../core/errors.ts";
import { CATEGORY, PAYMENT } from "../expenses/expenses.schema.ts";
import { usageDraftSchema } from "./usage-imports.schema.ts";
import type { UsageDraft } from "./usage-imports.schema.ts";
import type { UsageParseInput, UsageParserPort } from "./usage-parser.port.ts";

/** 카드 SMS → 지출 초안 추출 프롬프트. 취소 페어링·minor unit·연도 추론 규칙은 설계 문서 계약. */
export const SYSTEM_PROMPT = `당신은 한국 카드 SMS/앱푸시 사용내역 텍스트에서 여행 지출 초안을 추출하는 파서다.

규칙:
- 승인(지출) 내역만 추출한다. 입금·잔액·한도·광고 안내는 무시한다.
- 승인취소/거래취소/환불 항목은 같은 입력 안에서 대응하는 승인 건(같은 상호·금액)을 찾아 둘 다 제외한다. 대응 건이 입력에 없는 취소는 무시한다. 취소 라인만 버리고 승인을 남기지 마라. 페어링이 확실하지 않으면 승인 건을 유지하되 confidence를 낮춰라.
- 금액은 통화의 최소단위 정수 문자열로 변환한다. 예: 37,900원 → local_amount "37900"·local_currency "KRW" / $12.34 → "1234"·"USD" / ¥1,200 → "1200"·"JPY".
- 해외승인처럼 현지 금액과 카드 청구(승인) 금액이 함께 있으면 현지 금액을 local_amount로, 청구 금액을 card_billed_amount(최소단위 정수 문자열)·card_billed_currency(보통 "KRW")로 둘 다 담는다. 두 필드는 반드시 함께 채운다.
- 날짜에 연도가 없으면 기준일 기준 가장 최근 과거로 해석하고, 연도를 추론한 초안은 confidence를 낮춰라. 기준일보다 미래인 날짜를 만들지 마라.
- spent_at은 UTC ISO 8601로 변환한다(한국 시각 07/05 12:30 → "2026-07-05T03:30:00Z"). 시각이 없으면 03:00:00Z(정오 KST)로 두고 confidence를 낮춰라.
- title은 상호명만 간결하게. category와 payment_method는 확신할 때만 채운다.
- 각 초안의 confidence는 0~1 사이 숫자.
- 지출이 없으면 drafts를 빈 배열로 반환한다.`;

// PII 마스킹 — 파싱에 불필요한 식별자만 제거(상호·금액·일시는 보존). LLM 전송 전 필수 적용.
// 금액은 SMS에서 사실상 항상 콤마/통화기호를 동반하므로 12자리+ 무구두점 숫자 런은 fail-closed로 마스킹.
const PAN_SEP_RE = /(?:[\d*]{4}[-. ]){3}[\d*]{4}/g; // 4-4-4-4 (마스킹·-· ·. 구분 포함)
const PAN_RUN_RE = /[\d*]{12,19}/g; // 연속 PAN·계좌·마스킹 런
const CARD_SUFFIX_RE = /카드\s*\(\s*\d{2,4}\s*\)/g; // 신한카드(1234)
const CARD_TAIL_RE = /끝\s*자리\s*:?\s*\d{2,4}/g; // 끝자리 1234
const STAR_DIGITS_RE = /\*+[-\s]?\d{2,4}/g; // ****1234, *-1234 끝자리
const INTL_PHONE_RE = /\+82[\d\-.\s()]{8,14}/g;
const MOBILE_RE = /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g;
const LANDLINE_RE = /0\d{1,2}[-.)]\s?\d{3,4}[-.\s]\d{4}/g; // 02-1234-5678 · 031)123-4567
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const NAME_RE = /[가-힣]{1,3}\*{1,2}[가-힣]{0,3}님?/g; // 마스킹 이름(홍*동님·김**님)
const FULL_NAME_RE = /[가-힣]{1,4}님(?![가-힣])/g; // 비마스킹 이름(홍길동님) — 고객명 컨텍스트 fail-closed
const BALANCE_RE = /(누적|잔액|한도|가용)\s*(금액)?\s*:?\s*[\d,]+\s*원?/g; // 비거래 금액 — 파싱 불필요·오독 위험

export function redactSensitive(text: string): string {
  return text
    .replace(PAN_SEP_RE, "[카드번호]")
    .replace(PAN_RUN_RE, "[번호]")
    .replace(CARD_SUFFIX_RE, "카드([끝자리])")
    .replace(CARD_TAIL_RE, "[끝자리]")
    .replace(STAR_DIGITS_RE, "[끝자리]")
    .replace(INTL_PHONE_RE, "[전화번호]")
    .replace(MOBILE_RE, "[전화번호]")
    .replace(LANDLINE_RE, "[전화번호]")
    .replace(EMAIL_RE, "[이메일]")
    .replace(NAME_RE, "[이름]")
    .replace(FULL_NAME_RE, "[이름]")
    .replace(BALANCE_RE, "[제외]");
}

export function buildUserPrompt(input: UsageParseInput): string {
  return `기준일: ${input.referenceDate}\n사용내역 원문:\n${redactSensitive(input.text)}`;
}

const draftsPayloadSchema = z.object({ drafts: z.array(usageDraftSchema).max(50) });

/** 모델 출력(JSON.parse 결과) 재검증 — structured outputs가 못 거르는 범위(confidence 0..1 등) 포함. */
export function validateDrafts(raw: unknown): UsageDraft[] {
  const parsed = draftsPayloadSchema.safeParse(raw);
  if (!parsed.success)
    throw new UpstreamError("malformed parser output", { issues: parsed.error.issues });
  return parsed.data.drafts;
}

const MODEL = "claude-haiku-4-5"; // 저비용·structured outputs 지원(설계 문서 §파서 결정)

// structured outputs용 JSON schema — 수치 제약(min/max) 미지원이라 confidence 범위는 validateDrafts가 재검증.
const DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          local_amount: { type: "string" },
          local_currency: { type: "string" },
          spent_at: { type: "string" },
          category: { type: "string", enum: [...CATEGORY] },
          payment_method: { type: "string", enum: [...PAYMENT] },
          card_billed_amount: { type: "string" },
          card_billed_currency: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["title", "local_amount", "local_currency", "spent_at", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["drafts"],
  additionalProperties: false,
};

/** Claude LLM 어댑터. 실패는 onError 로깅 후 UpstreamError로 정규화(원문·상세 비노출). */
export class ClaudeUsageParser implements UsageParserPort {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly opts: { onError?: (e: unknown) => void } = {},
  ) {
    // maxRetries 1 — 사용자 대면 요청의 재시도 증폭 방지(비용·지연 상한)
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }

  async parse(input: UsageParseInput): Promise<UsageDraft[]> {
    try {
      const msg = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(input) }],
        output_config: { format: { type: "json_schema", schema: DRAFT_OUTPUT_SCHEMA } },
      });
      if (msg.stop_reason !== "end_turn")
        throw new UpstreamError("parser stopped abnormally", { stop_reason: msg.stop_reason });
      const textBlock = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      return validateDrafts(JSON.parse(textBlock?.text ?? "") as unknown);
    } catch (e) {
      this.opts.onError?.(e);
      throw e instanceof UpstreamError ? e : new UpstreamError("usage parse failed");
    }
  }
}
