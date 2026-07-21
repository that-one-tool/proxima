# AGENTS.md

Guidance for AI agents working in this repository. Keep it followed, keep it current.

## Project

**Proxima** — a minimalist TCP reverse proxy with per-service transformation. The first transformer proxies RESP services (Redis, Valkey): it transparently prefixes keys on the way in and strips the prefix on the way out, so multiple tenants share one Redis instance with key isolation.

## Layout

Turborepo monorepo, npm workspaces.

```
packages/core   @that-one-tool/proxima-core   proxy engine: connection pool, proxy manager,
                                               TCP/TLS servers, HTTP (health/metrics), config, logging, errors
packages/resp   @that-one-tool/proxima-resp    RESP transformer (key prefixing) + entrypoint; depends on core
config/eslint   @repo/eslint                   shared ESLint config
config/typescript @repo/typescript             shared tsconfig
docker/         docker-compose for local stack (proxy, redis, prometheus, ...)
```

## Toolchain

- **Node** `>=24` (`.nvmrc` pins v24.18.0) — run `nvm use` first.
- **TypeScript** strict (`strict: true`), CommonJS, target ES2022. core builds with `tsc`, resp bundles with esbuild.
- **Test**: Jest + ts-jest. Specs live in `test/unit/*.spec.ts`.
- **Lint**: ESLint (`typescript-eslint` type-checked) with `--max-warnings 0`.
- **Format**: Prettier. Runtime deps: `winston` (logging), `prom-client` (metrics).

## Commands

Run from repo root (Turbo fans out to packages):

```bash
npm run build          # build all packages
npm run test           # run all tests
npm run lint           # lint all packages (zero warnings allowed)
npm run format         # prettier --write across the repo
npm run check          # build + lint + test (use before declaring work done)
npm run check:fix      # build + format + lint:fix + test
npm run start:dev      # build and run the dev server
npm run start:all      # docker compose up the local stack
npm run stop:all       # docker compose down
```

Per package: `cd packages/<pkg> && npm run build | lint | test | check-types`.

## Rules

- **TDD.** Write or update the failing test first, then the code to make it pass.
- **Run tests after every change.** Fix all failures before considering a task done or moving on.
- **Minimal changes.** No refactoring of unrelated code. Do not touch files outside the task's scope without asking first.
- **Never commit or push.** The author reviews all changes; leave the working tree for review.
- **Don't assume — ask.** When a requirement is ambiguous or precision matters, ask. When two viable approaches exist, present both and let the author choose.
- **Keep docs current.** After any change that affects behavior or usage, update the relevant `README.md`, this `AGENTS.md`, and package docs in the same pass.

## Conventions

### Comments

- Minimal. Add one only when the code cannot express the *why* (a non-obvious tradeoff, a protocol quirk, a workaround). Never restate what the code already says.
- No commented-out code, no dead scaffolding.
- Reserve JSDoc for exported/public API where it adds real information.

### Naming

- Names carry the meaning — good names remove the need for comments.
- **Files**: `kebab-case.ts` (`connection-pool`, `tcp-tls-server-builder`, `resp-handling`).
- **Classes / types / interfaces**: `PascalCase` (`ProxyManager`, `ConnectionPool`, `ContextualError`).
- **Functions / variables**: `camelCase`, intention-revealing (`releaseConnection`, `isClientAllowedToConnect`).
- **Constants / const enums-as-objects**: `UPPER_SNAKE_CASE` (`KEY_COMMANDS`, `RESP`).
- No abbreviations or single letters except trivial loop indices. Booleans read as predicates (`isTls`, `hasPrefix`).

### Complexity

- Functions stay **small and single-purpose**, with **cyclomatic complexity < 4**.
- Prefer guard clauses and early returns over nested conditionals.
- Extract a well-named helper instead of growing a function past a screen or past the complexity limit.

### Style

- Prettier is authoritative: **tabs** (width 4), `printWidth` 140, single quotes, semicolons, trailing commas (`all`), `arrowParens: always`, LF endings. Run `npm run format`; never hand-format against it.
- TypeScript `strict` — no implicit `any`, prefer precise types and discriminated unions over runtime shape checks.
- Errors: wrap with the `errors/` classes (`WrappedError`, `ContextualError`) to preserve `cause` and context; don't swallow errors silently.
- Attach `error` listeners to every server/socket; never leave a rejection or emitter unhandled.
