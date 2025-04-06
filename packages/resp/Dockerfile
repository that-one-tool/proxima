FROM node:22.14.0-alpine3.21 AS base 

FROM base AS builder
WORKDIR /app
RUN npm i -g turbo
COPY . .
RUN turbo prune @that-one-tool/proxima-resp --docker

FROM base AS installer
WORKDIR /app

COPY --from=builder /app/out/json/ .
RUN npm i

COPY --from=builder /app/out/full/ .

RUN npm run build

FROM base AS runner
WORKDIR /app

COPY --from=installer /app .

EXPOSE 9101
EXPOSE 7000-7010
CMD node packages/resp/dist/index.js