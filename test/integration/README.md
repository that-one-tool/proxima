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
  (`node --test`). No jest / ts-jest / swc involved.
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

Each test file boots its own Redis container and spawned proxy process, and `node --test` runs files
concurrently — expect several containers at once. On a constrained machine, serialize with
`node --test --test-concurrency=1 "test/**/*.test.ts"`.

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
  prefixing.test.ts               SET/GET, MSET/MGET, DEL, HSET/HGET, EXPIRE, pipelines, binary keys
                                  and values, concurrent clients, key-carrying replies (BLPOP/LMPOP/
                                  XREAD names un-prefixed), the trusted HTTP healthcheck
  isolation.test.ts               two tenants / two ports / two prefixes cannot cross; KEYS and SCAN
                                  (with and without MATCH) stay inside the tenant namespace
  command-isolation.test.ts       default-deny: FLUSHALL / SUBSTR / RANDOMKEY / EVAL are rejected, and
                                  a denial never desyncs later replies on the same connection
  transactions-and-pubsub.test.ts MULTI/EXEC queued-command prefixing; pub/sub passthrough (payloads
                                  are never rewritten once a session subscribes)
  connection-state.test.ts        pooled upstream lifecycle: clean sessions are recycled (same CLIENT ID),
                                  dirty ones (SELECT n≠0, ...) are destroyed instead of leaking state
  ip-whitelist.test.ts            a non-whitelisted client is dropped before any byte reaches the service
  regression-guards.test.ts       large split frames, empty-array pipelines, prefix-shaped values
```

## Regression guards

`regression-guards.test.ts` asserts the **correct** behavior for three correctness bugs found in an
earlier review and since fixed. All three are expected to **pass**; a red result means a fix has
regressed.

| Test                                                                       | Guards against                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a >64KB value still stores the key under the tenant prefix`               | Frame reassembly: a value larger than one socket read splits its RESP frame across TCP segments; without reassembly the key would be forwarded **unprefixed**.                     |
| `a command following an empty-array frame is still prefixed`               | Empty-array handling: a `*0` frame mid-pipeline must not abort parsing, or every later command in the same write goes out **unprefixed**.                                          |
| `a value whose bytes start with the tenant prefix round-trips uncorrupted` | Correlated stripping: only replies to key-returning commands (`KEYS`/`SCAN`) are un-prefixed, so a stored value that legitimately begins with the prefix bytes is never corrupted. |
