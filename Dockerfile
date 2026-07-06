# homelab GHCR 이미지(linux/arm64, reusable-app-build.yaml). 공유 차트 PSA restricted 준수:
# non-root(65532)·read-only rootfs·drop ALL caps(런타임은 차트가 강제, 이미지도 정합).
FROM oven/bun:1-alpine
WORKDIR /app

# 의존성 레이어 캐시: 매니페스트 먼저. --production = devDeps(drizzle-kit 등) 제외.
# 마이그레이션은 drizzle-orm 런타임 마이그레이터(dependencies)라 prod 이미지에서 동작.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# 사용내역 파싱 codex 엔진(선택, USAGE_PARSER_ENGINE=codex) — musl 릴리스 바이너리 직설치.
# 런타임엔 CODEX_HOME(auth.json secret + writable) 마운트 필요(차트/values, 설계 §엔진 선택).
ARG CODEX_VERSION=0.142.3
RUN wget -qO /tmp/codex.tar.gz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-aarch64-unknown-linux-musl.tar.gz" \
  && tar -xzf /tmp/codex.tar.gz -C /tmp \
  && mv /tmp/codex-aarch64-unknown-linux-musl /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/codex \
  && rm -f /tmp/codex.tar.gz \
  && codex --version

COPY . .

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# 차트가 runAsUser:65532를 강제하지만 이미지도 비-root 기본값으로 정합(로컬 docker run 시에도).
USER 65532:65532
CMD ["bun", "src/main.ts"]
