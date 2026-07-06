import { describe, expect, it } from "vitest";
import { createUsageMetrics } from "./metrics.ts";

describe("createUsageMetrics — 무의존 Prometheus registry", () => {
  it("outcome별 요청 카운터를 증가시킨다", () => {
    const m = createUsageMetrics();
    m.recordRequest("ok");
    m.recordRequest("ok");
    m.recordRequest("error");
    const out = m.render();
    expect(out).toContain('usage_parse_requests_total{outcome="ok"} 2');
    expect(out).toContain('usage_parse_requests_total{outcome="error"} 1');
  });
  it("duration을 sum·count로 누적한다", () => {
    const m = createUsageMetrics();
    m.recordDuration(1.5);
    m.recordDuration(0.5);
    const out = m.render();
    expect(out).toContain("usage_parse_duration_seconds_sum 2");
    expect(out).toContain("usage_parse_duration_seconds_count 2");
  });
  it("Prometheus 텍스트 포맷(HELP·TYPE 헤더)을 낸다", () => {
    const out = createUsageMetrics().render();
    expect(out).toContain("# TYPE usage_parse_requests_total counter");
    expect(out).toContain("# TYPE usage_parse_duration_seconds summary");
  });
  it("라벨 값은 Prometheus 이스케이프(따옴표·백슬래시)한다", () => {
    const m = createUsageMetrics();
    m.recordRequest('a"b\\c');
    expect(m.render()).toContain('usage_parse_requests_total{outcome="a\\"b\\\\c"} 1');
  });
});
