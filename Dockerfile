FROM oven/bun:1-alpine AS base
WORKDIR /app
COPY package.json bun.lock bun.lockb* ./
RUN bun install --frozen-lockfile --production
COPY . .
EXPOSE 3000
CMD ["bun", "src/main.ts"]
