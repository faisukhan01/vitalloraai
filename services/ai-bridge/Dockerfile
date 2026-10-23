# VITALORA AI bridge (Bun sidecar wrapping the ZAI SDK) — production image
# Build from services/ai-bridge:
#   docker build -t vitalora-bridge .
FROM oven/bun:1-slim

WORKDIR /srv/bridge
ENV NODE_ENV=production
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile || bun install
COPY index.ts ./
EXPOSE 8100
CMD ["bun", "index.ts"]
