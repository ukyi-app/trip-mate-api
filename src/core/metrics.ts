/** 사용내역 파싱 메트릭 — 무의존 Prometheus 텍스트 포맷 registry(주입형, 테스트 격리). */
export interface UsageMetrics {
  recordRequest(outcome: string): void;
  recordDuration(seconds: number): void;
  render(): string;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function createUsageMetrics(): UsageMetrics {
  const requests = new Map<string, number>(); // outcome → count
  let durationSum = 0;
  let durationCount = 0;

  return {
    recordRequest(outcome) {
      requests.set(outcome, (requests.get(outcome) ?? 0) + 1);
    },
    recordDuration(seconds) {
      durationSum += seconds;
      durationCount += 1;
    },
    render() {
      const lines: string[] = [];
      lines.push("# HELP usage_parse_requests_total 사용내역 파싱 요청 수(outcome별).");
      lines.push("# TYPE usage_parse_requests_total counter");
      for (const [outcome, count] of requests)
        lines.push(`usage_parse_requests_total{outcome="${escapeLabel(outcome)}"} ${count}`);
      lines.push("# HELP usage_parse_duration_seconds 사용내역 파싱 소요 시간(초).");
      lines.push("# TYPE usage_parse_duration_seconds summary");
      lines.push(`usage_parse_duration_seconds_sum ${durationSum}`);
      lines.push(`usage_parse_duration_seconds_count ${durationCount}`);
      return `${lines.join("\n")}\n`;
    },
  };
}
