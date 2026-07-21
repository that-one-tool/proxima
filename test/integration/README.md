# Proxima integration tests

End-to-end tests that stand up **real infrastructure** and drive traffic through the actual proxy:

1. A real **Redis** container (via [`testcontainers`](https://testcontainers.com/)) as the upstream.
2. The **real built RESP service** (`packages/resp/dist/index.js`) spawned as a child process,
   configured exactly like production (env vars: `PORT_MAPPING`, `FORWARD_SERVICE_HOST/PORT`,
   `IP_WHITELIST`, `TRUSTED_HTTP_PORT`).
3. A real **ioredis** client connected _through_ the proxy, plus a direct client to Redis to verify
   what was actually stored.

These validate behavior the mocked unit tests cannot: the bytes that reach Redis and come back to a
real client.

## Requirements

- **Node >= 24** — tests are TypeScript and run under the built-in runner via native type-stripping
  (`node --test`). No jest / ts-jest / swc involved, so the repo-wide jest breakage does not affect
  this suite.
- **A working Docker runtime** (Docker Desktop, Colima, Podman with the Docker API, etc.).
  `testcontainers` needs it to start Redis. Without it every suite fails in its `before` hook with
  `Could not find a working container runtime strategy` — the test bodies never run.

## Running

From the repo root:

```bash
npm run test:integration
```

This builds all packages first (so `packages/resp/dist/index.js` exists), then runs the suite.
Or, from this directory after a build:

```bash
npm run test:integration        # node --test "test/**/*.test.ts"
```

The suite is **not** part of `npm test` (turbo `test`) — it has its own `test:integration` script and
no `test` script, so the default unit-test run never pulls in Docker.

## Layout

```
src/
  ports.ts             free-port allocation + TCP readiness polling
  redis-container.ts   starts the upstream Redis container
  proxima-harness.ts   spawns the built RESP service, waits for its ports, tears it down
  resp-raw.ts          raw RESP framing + a raw TCP client (for byte-level edge cases)
  environment.ts       orchestrates Redis + Proxima + ioredis clients into one fixture
test/
  prefixing.test.ts            SET/GET, MSET/MGET, DEL, HSET/HGET, EXPIRE, pipelines  (expected PASS)
  isolation.test.ts            two tenants / two ports / two prefixes cannot cross     (expected PASS)
  known-bug-edge-cases.test.ts large values, pipeline poisoning, prefix-shaped values (expected FAIL)
```

## Known-bug edge cases (expected to fail until fixed)

`known-bug-edge-cases.test.ts` asserts the **correct** behavior for three findings in
`REVIEW-second-pass-2026-07-21.md`. They are expected to **fail against current code** and are
deliberately not skipped or marked `todo` — a red result is the point; it proves the suite has real
diagnostic power. Each turns green when the underlying bug is fixed.

| Test | REVIEW finding | Why current code fails |
| --- | --- | --- |
| `a >64KB value still stores the key under the tenant prefix` | #1 — no frame reassembly | A value larger than one socket read splits the RESP frame across TCP segments; the per-chunk transform can't parse the whole frame and forwards the key **unprefixed**. |
| `a command following an empty-array frame is still prefixed` | #2 — null parse aborts the rest | A `*0` frame mid-pipeline makes the parser bail and forward everything after it raw, so the trailing command's key is **unprefixed**. |
| `a value whose bytes start with the tenant prefix round-trips uncorrupted` | #3 — blind response stripping | The response transformer strips the prefix from **any** bulk string starting with those bytes, corrupting a stored value that legitimately begins with the prefix. |
```
