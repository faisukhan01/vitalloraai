# VITALORA AI web (Next.js) — production image
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t vitalora-web .
FROM oven/bun:1 AS builder

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/api-client/package.json packages/api-client/
COPY services/ai-bridge/package.json services/ai-bridge/
RUN bun install --frozen-lockfile

COPY apps/web apps/web
COPY packages packages
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time public config (safe to bake; no secrets here)
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_API_PORT=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_PORT=$NEXT_PUBLIC_API_PORT
RUN cd apps/web && bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["bun", "apps/web/server.js"]
