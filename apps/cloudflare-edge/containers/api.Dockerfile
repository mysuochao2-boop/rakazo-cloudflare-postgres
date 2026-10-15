FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    API_HOST=0.0.0.0 \
    API_PORT=3100

WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --chmod=755 . .
RUN pnpm install --frozen-lockfile --prod --filter @rakazo/api... && pnpm --filter @rakazo/db generate

ENV NODE_ENV=production
EXPOSE 3100
USER node
CMD ["pnpm", "--filter", "@rakazo/api", "start"]
