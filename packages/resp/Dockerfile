FROM node:24.18-alpine3.24 AS base

FROM base AS builder
WORKDIR /app
RUN npm i -g turbo@2.10.5
COPY . .
RUN turbo prune @that-one-tool/proxima-resp --docker

FROM base AS installer
WORKDIR /app

COPY --from=builder /app/out/json/ .
RUN npm ci

COPY --from=builder /app/out/full/ .

RUN npm run build

FROM base AS runner
WORKDIR /app

COPY --from=builder /app/out/json/ .
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=installer /app/packages/core/dist ./packages/core/dist
COPY --from=installer /app/packages/resp/dist ./packages/resp/dist

USER node

EXPOSE 9101
EXPOSE 7000-7010
CMD ["node", "packages/resp/dist/index.js"]
