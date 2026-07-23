# Proxima RESP

Proxima implementation for proxying RESP compatible services (Redis, Valkey, ...)

## Features

- Transparently proxies Redis commands
- Automatically adds a prefix to all keys in supported Redis commands
- Removes prefixes from keys in Redis responses
- Different prefixes can be configured for different ports
- Preserves the Redis RESP protocol format
- Multiple tenants can share a single Redis instance with key isolation
- **Default-deny command policy**: only commands the proxy can safely scope to the tenant prefix are
  forwarded; `KEYS`/`SCAN` are scoped to the prefix, and anything that would cross the tenant boundary
  (`FLUSHALL`, `SWAPDB`, `CONFIG`, `RANDOMKEY`, `EVAL`, `SUBSTR`, unknown commands, …) is rejected
- IP whitelist and blacklist for access control

## Configuration

### Environment Variables

- `PORT_MAPPING`: Configures multiple port-to-prefix mappings in the format "port1:prefix1,port2:prefix2". A
  trailing colon is appended to each prefix when absent (so `7000:app1` prefixes keys with `app1:`).
- `DEFAULT_PORT_MAPPING`: Sets the default prefix to use when no `PORT_MAPPING` is provided (default: "default")
- `DEFAULT_LISTENING_PORT`: Sets the default port to listen on when no port mappings are provided (default: 7000)
- `FORWARD_SERVICE_HOST`: Upstream RESP service address (default: "127.0.0.1")
- `FORWARD_SERVICE_PORT`: Upstream RESP service port (default: 6379)
- `FORWARD_SERVICE_NAME`: Label used for the upstream service in logs and metrics (default: "unknown-forward-service")
- `TRUSTED_HTTP_PORT`: Port exposing the healthcheck (`/api/v1/healthcheck`) and Prometheus metrics
  (`/api/v1/metrics`) endpoints (default: 9101)
- `IP_WHITELIST`: Comma-separated list of IP addresses allowed to connect (use "\*.\*.\*.\*" to allow all)
- `IP_BLACKLIST`: Comma-separated list of IP addresses that are blocked from connecting
- `CLIENT_IDLE_TIMEOUT_MS`: Close a client connection (and release its pooled service connection) after this many
  milliseconds of inactivity, preventing idle clients from exhausting the pool. `0` (default) disables it.

Connection-pool sizing (`FORWARD_SERVICE_MIN_POOL_CONNECTIONS`, `FORWARD_SERVICE_MAX_POOL_CONNECTIONS`, …) and
TLS (`TLS_CLIENT_*`, `TLS_SERVER_*`) are handled by the core engine; see `packages/core` for those variables.

### Examples

```bash
# Configure multiple ports with different prefixes
PORT_MAPPING="6380:app1,6381:app2,6382:app3" npm start

# Configure a single port with a specific prefix
PORT_MAPPING="6380:myapp" npm start

# Set a custom default prefix and use IP whitelist
DEFAULT_PORT_MAPPING="myservice" IP_WHITELIST="192.168.1.5,10.0.0.2" npm start
```

### Default Configuration

If no `PORT_MAPPING` is provided, the system will:

1. Listen on the port specified by `DEFAULT_LISTENING_PORT` (defaults to 7000)
2. Use the prefix specified by `DEFAULT_PORT_MAPPING` (defaults to "default:")

### Security

By default, the proxy allows connections from no IP address. You can explicitly allow or restrict access by:

1. Using `IP_WHITELIST` to specify allowed IPs (or use "\*.\*.\*.\*" to allow all)
2. Using `IP_BLACKLIST` to block specific IPs even if they're in the whitelist

## Installation

```bash
# Install dependencies
npm install
```

## Usage

### Build the project

```bash
npm run build
```

### Start the server with custom port-prefix mappings

```bash
# Using multiple port-prefix mappings
PORT_MAPPING="6380:tenant1,6381:tenant2,6382:tenant3" npm start

# Single mapping
PORT_MAPPING="8000:myservice" npm start

# Using the default prefix
DEFAULT_PORT_MAPPING="legacy:" npm start
```

### Development mode (build and start)

```bash
PORT_MAPPING="6380:dev" npm run dev
```

## Connecting to the proxy

Connect your Redis client to the appropriate proxy port based on the prefix you want:

```bash
# For prefix "tenant1:"
redis-cli -p 6380

# For prefix "tenant2:"
redis-cli -p 6381
```

## How It Works

The proxy works by:

1. Automatically prefixing all keys in commands sent from clients to Redis
2. Automatically removing those prefixes from responses before returning to clients
3. Making the prefixing completely transparent to client applications

For example:

- Client sends: `GET mykey`
- Proxy forwards to Redis: `GET tenant1:mykey`
- Redis responds with: `$10\r\ntenant1:123\r\n`
- Proxy returns to client: `$3\r\n123\r\n`

This bidirectional transformation ensures client applications don't need to be aware of the prefixing system.

## Multi-Tenant Usage

This proxy allows multiple applications or tenants to safely share a single Redis instance:

1. Assign a unique port and prefix to each tenant
2. Each tenant connects to their designated port
3. All keys are automatically prefixed with the tenant's prefix
4. Keys from different tenants are isolated from each other

## Supported Redis Commands

The proxy automatically prefixes keys for ~120 key-bearing commands, grouped by how their key arguments are positioned:

- **Single key at argument 0** — strings (`GET`, `GETSET`, `GETDEL`, `GETEX`, `SET`, `SETNX`, `SETEX`, `PSETEX`, `APPEND`, `STRLEN`, `GETRANGE`, `SETRANGE`, `INCR`/`DECR` family, `SETBIT`, `GETBIT`, `BITCOUNT`, `BITPOS`, `BITFIELD`), key/TTL generics (`EXPIRE`/`PEXPIRE`/`EXPIREAT`/`PEXPIREAT`/`EXPIRETIME`/`PEXPIRETIME`, `TTL`/`PTTL`, `PERSIST`, `TYPE`, `DUMP`), hashes (`HGET`, `HSET`, `HSETNX`, `HMSET`, `HMGET`, `HDEL`, `HGETALL`, `HKEYS`, `HVALS`, `HLEN`, `HEXISTS`, `HINCRBY`/`HINCRBYFLOAT`, `HSTRLEN`, `HSCAN`, `HRANDFIELD`), lists (`LPUSH`/`RPUSH`/`LPUSHX`/`RPUSHX`, `LPOP`/`RPOP`, `LRANGE`, `LLEN`, `LINDEX`, `LSET`, `LINSERT`, `LREM`, `LTRIM`, `LPOS`), sets (`SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SMISMEMBER`, `SCARD`, `SPOP`, `SRANDMEMBER`, `SSCAN`), sorted sets (`ZADD`, `ZREM`, `ZSCORE`/`ZMSCORE`, `ZRANGE` family, `ZRANK`/`ZREVRANK`, `ZCARD`, `ZCOUNT`, `ZLEXCOUNT`, `ZINCRBY`, `ZSCAN`, `ZPOPMIN`/`ZPOPMAX`), streams (`XADD`, `XLEN`, `XRANGE`/`XREVRANGE`, `XDEL`, `XTRIM`), geo (`GEOADD`, `GEOPOS`, `GEODIST`, `GEOHASH`, `GEOSEARCH`) and `PFADD`.
- **Two keys at arguments 0 and 1** — `RENAME`, `RENAMENX`, `COPY`, `SMOVE`, `LMOVE`, `BLMOVE`, `RPOPLPUSH`, `BRPOPLPUSH`, `LCS`.
- **Every argument is a key** — `DEL`, `UNLINK`, `TOUCH`, `EXISTS`, `WATCH`, `MGET`, `SINTER`, `SUNION`, `SDIFF`, `PFCOUNT`, `PFMERGE`.
- **Keys at even positions (key/value pairs)** — `MSET`, `MSETNX`.

The fixed-position mapping lives in the `KEY_POSITIONS` map in `src/resp-constants.ts`; `KEY_COMMANDS` is derived from it. Add fixed-position commands by adding an entry to `KEY_POSITIONS`.

Commands whose key positions depend on a variadic count, a subcommand, or an options structure are resolved at parse time by `KEY_RESOLVERS` (also in `src/resp-constants.ts`):

- **All args from an offset are keys** — `BITOP` (destination + every source).
- **Keys up to a trailing timeout** — the blocking `BLPOP`, `BRPOP`, `BZPOPMIN`, `BZPOPMAX`.
- **A `numkeys` count precedes the keys** — `ZUNION`/`ZINTER`/`ZDIFF`, `SINTERCARD`, `LMPOP`/`ZMPOP`/`BLMPOP`/`BZMPOP`, and the `*STORE` variants (`ZUNIONSTORE`, `ZINTERSTORE`, `ZDIFFSTORE`) whose destination sits before the count.
- **A key only for certain subcommands** — `OBJECT` (`ENCODING`/`REFCOUNT`/`IDLETIME`/`FREQ`) and `MEMORY` (`USAGE`).
- **`SORT`/`SORT_RO`** — the source key plus every `BY`, `GET`, and `STORE` pattern; the `GET #` self-reference is left untouched.

## Command isolation (default-deny)

Isolation is enforced as an **allowlist**: a client command is forwarded to the shared service only if the
proxy can guarantee it stays within the tenant's namespace. Everything else is denied — the frame is
rewritten to a harmless unknown-command so the service answers with an error, without ever executing the
forbidden command (this preserves one-reply-per-command ordering). The policy tables live in
`src/resp-constants.ts`.

- **Prefixed** — the ~120 key commands above (`KEY_POSITIONS` / `KEY_RESOLVERS`). Keys are always
  prefixed, even a key that already starts with the prefix (skipping it would alias `foo` with
  `<prefix>foo`).
- **Scoped** — `KEYS <pattern>` becomes `KEYS <prefix><pattern>`, and `SCAN` has its `MATCH` pattern
  prefixed (a scoped `MATCH <prefix>*` is injected when the client omits it), so neither can enumerate
  another tenant's keys. Their replies are un-prefixed on the way back.
- **Key-carrying replies** — replies that embed key names are un-prefixed **positionally** (never the
  values next to them): `KEYS`/`SCAN` results, the source key of `BLPOP`/`BRPOP`/`BZPOPMIN`/`BZPOPMAX`
  and `LMPOP`/`ZMPOP`/`BLMPOP`/`BZMPOP`, and the stream names of `XREAD`/`XREADGROUP`. The shapes live
  in `REPLY_KEY_SHAPES` in `src/resp-constants.ts`.
- **Passthrough** — keyless commands that do not cross the key boundary: connection/handshake
  (`PING`, `ECHO`, `HELLO`, `AUTH`, `SELECT`, `RESET`, `CLIENT`, `COMMAND`, `INFO`, …), transactions
  (`MULTI`/`EXEC`/`DISCARD`/`UNWATCH`), and pub/sub. Extend `PASSTHROUGH_COMMANDS` to permit more.
- **Denied** — everything else, including administrative/global commands (`FLUSHALL`, `FLUSHDB`,
  `SWAPDB`, `CONFIG`, `SHUTDOWN`, `DEBUG`, `MONITOR`, `REPLICAOF`), `RANDOMKEY` (cannot be scoped),
  Lua/function commands (`EVAL`/`EVALSHA`/`FCALL`) whose caller-supplied key list would bypass prefixing,
  and legacy readers like `SUBSTR`. Non-RESP (inline) requests are denied for the same reason.

### Connection-state isolation (destroy-on-dirty)

The upstream connection pool is shared across all tenants, so a pooled socket a tenant used can be
re-leased to a different tenant. Key isolation is unaffected (the prefix comes from the port mapping, not
the socket), but a **passthrough** command can leave _connection-scoped_ state on the socket that would
otherwise leak to the next tenant. The transformer therefore flags a session "recycle-unsafe" (via the
`RECYCLE_UNSAFE_KEY` `SessionState` contract) when it forwards such a command, and the proxy **destroys**
that connection on release instead of pooling it, replacing it with a fresh one. Flagged as unsafe:

- `SELECT` to a non-zero DB, `AUTH`, `HELLO 3` (or `HELLO … AUTH …`), `SUBSCRIBE`/`PSUBSCRIBE`/`SSUBSCRIBE`,
  `CLIENT REPLY`/`CLIENT TRACKING`.
- An **open** `MULTI` or `WATCH` (the balance is tracked, so a completed `MULTI`/`EXEC` or `WATCH`/`UNWATCH`
  stays recyclable; `RESET` clears everything). Benign metadata like `CLIENT SETNAME`/`SETINFO` does not
  flag the session, so the common client handshake keeps the connection poolable.

### Known limitations

- **RESP3 (`HELLO 3`)**: once a client negotiates RESP3, response-side prefix stripping is disabled for
  that session (fail-safe — the prefix may show through on a `KEYS` reply, but no value is ever
  corrupted). Requests are still fully prefixed/scoped/denied, so isolation holds.
- **Transactions**: keys inside `MULTI`/`EXEC` are prefixed and scoped on the request side, but the
  `EXEC` result array is not un-prefixed, so a `KEYS`/`SCAN` executed inside a transaction returns
  prefixed names (cosmetic; still in-namespace).
- **Pub/sub channels** are forwarded unchanged — channel isolation is out of scope; only keys are namespaced.
