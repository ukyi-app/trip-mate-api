# homelab GHCR 이미지(linux/arm64, reusable-app-build.yaml). 공유 차트 PSA restricted 준수:
# non-root(65532)·read-only rootfs·drop ALL caps(런타임은 차트가 강제, 이미지도 정합).
FROM oven/bun:1-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
WORKDIR /app

# 의존성 레이어 캐시: 매니페스트 먼저. --production = devDeps(drizzle-kit 등) 제외.
# 마이그레이션은 drizzle-orm 런타임 마이그레이터(dependencies)라 prod 이미지에서 동작.
#
# ⚠️ --ignore-scripts를 빼지 말 것. 이 prod 트리에서 설치 스크립트를 가진 패키지는 셋뿐이고
#   (@prisma/client·better-sqlite3·esbuild) 전부 better-auth의 optional peer로 딸려온 것이라
#   소스에서 참조가 0이다 — 스크립트를 건너뛰어도 설치되는 패키지 수는 그대로다(실측 134/134).
#   반면 amd64 leg는 QEMU 에뮬레이션을 타는데, 거기서 bun 1.4.0은 postinstall을 실행하는 순간
#   JSC 힙 블록을 못 얻어 RSS 24MB 시점에 MemoryExhaustion으로 abort한다
#   (qemu: uncaught target signal 6). bun은 그 뒤 재시도에 들어가고, release는 6시간 타임아웃까지
#   갔다(2026-08-24 실측). BUN_JSC_useJIT=0·forceRAMSize로는 못 막는다 — 둘 다 같은 자리에서 죽는다.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# 사용내역 파싱 codex 엔진(선택, USAGE_PARSER_ENGINE=codex) — musl 릴리스 바이너리 직설치.
# 런타임엔 CODEX_HOME(auth.json secret + writable) 마운트 필요(차트/values, 설계 §엔진 선택).
# ⚠️ TARGETARCH에 기본값을 주지 말 것 — stage-level ARG 기본값은 BuildKit predefined platform arg를
#   이겨서, 잘못된 아키텍처 바이너리를 담은 이미지를 조용히 만든다. 비워두면 아래 case가 exit 1로 막는다.
#   추출 디렉토리 이름도 triple에서 파생되므로 URL뿐 아니라 mv 경로에도 같은 변수를 쓴다.
#   말미의 `codex --version`은 이 Dockerfile의 유일한 자기검증이다 — 제거하지 말 것.
ARG TARGETARCH
ARG CODEX_VERSION=0.142.3
RUN case "$TARGETARCH" in \
      arm64) CODEX_TRIPLE=aarch64-unknown-linux-musl ;; \
      amd64) CODEX_TRIPLE=x86_64-unknown-linux-musl  ;; \
      *) echo "지원하지 않는 TARGETARCH='$TARGETARCH' — arm64|amd64만 지원" >&2; exit 1 ;; \
    esac \
  && wget -qO /tmp/codex.tar.gz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${CODEX_TRIPLE}.tar.gz" \
  && tar -xzf /tmp/codex.tar.gz -C /tmp \
  && mv "/tmp/codex-${CODEX_TRIPLE}" /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/codex \
  && rm -f /tmp/codex.tar.gz \
  && codex --version

COPY . .

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# 차트가 runAsUser:65532를 강제하지만 이미지도 비-root 기본값으로 정합(로컬 docker run 시에도).
USER 65532:65532
CMD ["bun", "src/main.ts"]
