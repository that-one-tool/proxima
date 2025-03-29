# Proxima Core

A minimalist TCP reverse proxy server for various services.

## Features

- Transparently proxies Redis commands
- Automatically adds a prefix to all keys in supported Redis commands
- Removes prefixes from keys in Redis responses
- Different prefixes can be configured for different ports
- Preserves the Redis RESP protocol format
- Multiple tenants can share a single Redis instance with key isolation
- IP whitelist and blacklist for access control

## Configuration

### Environment Variables

- `PORT_PREFIX_MAP`: Configures multiple port-to-prefix mappings in the format "port1:prefix1,port2:prefix2"
- `DEFAULT_KEY_PREFIX`: Sets the default prefix to use when no specific mapping is provided (default: "default:")
- `DEFAULT_LISTENING_PORT`: Sets the default port to listen on when no port mappings are provided (default: 6380)
- `REDIS_HOST`: Redis server address (default: "127.0.0.1")
- `REDIS_PORT`: Redis server port (default: 6379)
- `IP_WHITELIST`: Comma-separated list of IP addresses allowed to connect (use "_._._._" to allow all)
- `IP_BLACKLIST`: Comma-separated list of IP addresses that are blocked from connecting

### Examples

```bash
# Configure multiple ports with different prefixes
PORT_PREFIX_MAP="6380:app1,6381:app2,6382:app3" npm start

# Configure a single port with a specific prefix
PORT_PREFIX_MAP="6380:myapp" npm start

# Set a custom default prefix and use IP whitelist
DEFAULT_KEY_PREFIX="myservice" IP_WHITELIST="192.168.1.5,10.0.0.2" npm start
```

### Default Configuration

If no `PORT_PREFIX_MAP` is provided, the system will:

1. Listen on the port specified by `DEFAULT_LISTENING_PORT` (defaults to 6380)
2. Use the prefix specified by `DEFAULT_KEY_PREFIX` (defaults to "default:")

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
PORT_PREFIX_MAP="6380:tenant1,6381:tenant2,6382:tenant3" npm start

# Single mapping
PORT_PREFIX_MAP="8000:myservice" npm start

# Using the default prefix
DEFAULT_KEY_PREFIX="legacy:" npm start
```

### Development mode (build and start)

```bash
PORT_PREFIX_MAP="6380:dev" npm run dev
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

The proxy automatically prefixes keys for the following Redis commands:

- GET, SET
- HGET, HSET
- DEL, EXISTS
- INCR, DECR
- LPUSH, RPUSH, LRANGE
- EXPIRE, TTL

Additional commands can be added by modifying the `KEY_COMMANDS` array in the source code.
