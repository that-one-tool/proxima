/// <reference types="jest" />
import { EventEmitter } from 'node:events';

const poolInstances: any[] = [];

jest.mock('../../src/logging', () => ({
	Logger: {
		getInstance: jest.fn(() => ({
			info: jest.fn(),
			debug: jest.fn(),
			error: jest.fn(),
			warn: jest.fn(),
		})),
	},
}));

jest.mock('../../src/connection-pool', () => {
	const { EventEmitter: Emitter } = require('node:events');
	return {
		ConnectionPool: jest.fn().mockImplementation(() => {
			const pool: any = new Emitter();
			pool.getConnection = jest.fn();
			pool.releaseConnection = jest.fn();
			pool.closeConnection = jest.fn();
			pool.shutdown = jest.fn().mockResolvedValue(undefined);
			poolInstances.push(pool);
			return pool;
		}),
	};
});

jest.mock('../../src/servers/tcp-tls-server-builder', () => {
	const { EventEmitter: Emitter } = require('node:events');
	return {
		ServerBuilder: jest.fn().mockImplementation(() => ({
			createServer: jest.fn(() => {
				const server: any = new Emitter();
				server.listen = jest.fn();
				server.close = jest.fn();
				return server;
			}),
		})),
	};
});

import { ProxyManager } from '../../src/proxy-manager';
import { LeasedConnection } from '../../src/connection-pool/leased-connection';
import { RECYCLE_UNSAFE_KEY } from '../../src/types';

class FakeSocket extends EventEmitter {
	remoteAddress = '10.0.0.1';
	write = jest.fn(() => true);
	end = jest.fn();
	destroy = jest.fn();
	pause = jest.fn();
	resume = jest.fn();
	setTimeout = jest.fn();
}

function makeConfig(overrides: Record<string, unknown> = {}): any {
	return {
		forwardServiceOptions: { host: 'localhost', port: 6379, name: 'redis' },
		tlsClientOptions: { useTls: false },
		tlsServerOptions: { useTls: false },
		portMapping: {},
		ipBlacklist: [],
		ipWhitelist: ['*.*.*.*'],
		...overrides,
	};
}

/**
 * Wire the mocked pool to hand out real {@link LeasedConnection} wrappers over `socket` and to
 * reproduce the pool's own teardown: `releaseConnection` detaches the lease's listeners, and
 * `closeConnection` destroys the socket. A fresh wrapper is minted per acquisition, exactly as the
 * real pool does on each lease, so reuse doesn't resuse a detached wrapper.
 */
function primePool(pool: any, socket: FakeSocket): void {
	let active: LeasedConnection | undefined;

	pool.getConnection.mockImplementation(() => {
		const record: any = { id: 'C-1', socket, leaseId: 7, status: 'busy', lastUsed: 0 };
		record.lease = new LeasedConnection(record);
		active = record.lease;
		return Promise.resolve(record.lease);
	});
	pool.releaseConnection.mockImplementation(() => active?.detach());
	pool.closeConnection.mockImplementation(() => {
		active?.detach();
		socket.removeAllListeners();
	});
}

function listen(manager: ProxyManager, config: any, client: FakeSocket): Promise<void> {
	return (manager as unknown as { listenConnection: (c: any, s: FakeSocket, p: number, m: string) => Promise<void> }).listenConnection(
		config,
		client,
		6379,
		'tenant:',
	);
}

beforeEach(() => {
	poolInstances.length = 0;
	jest.clearAllMocks();
});

describe('ProxyManager authorization', () => {
	it('closes the connection for a disallowed client and never acquires from the pool', async () => {
		const config = makeConfig({ ipWhitelist: [] });
		const manager = new ProxyManager(config);
		const client = new FakeSocket();

		await listen(manager, config, client);

		expect(client.end).toHaveBeenCalled();
		expect(client.destroy).toHaveBeenCalled();
		expect(poolInstances[0].getConnection).not.toHaveBeenCalled();
	});
});

describe('ProxyManager listener lifecycle (Bug #1)', () => {
	it('strips the service socket listeners on graceful release and does not accumulate them on reuse', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);

		const firstClient = new FakeSocket();
		await listen(manager, config, firstClient);
		expect(serviceSocket.listenerCount('data')).toBe(1);

		firstClient.emit('close');
		expect(pool.releaseConnection).toHaveBeenCalledWith('C-1', 7);
		expect(serviceSocket.listenerCount('data')).toBe(0);
		expect(serviceSocket.listenerCount('close')).toBe(0);
		expect(serviceSocket.listenerCount('error')).toBe(0);

		const secondClient = new FakeSocket();
		await listen(manager, config, secondClient);
		expect(serviceSocket.listenerCount('data')).toBe(1);
	});
});

describe('ProxyManager double release (Bug #2)', () => {
	it('releases exactly once when the client emits error then close', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);

		const client = new FakeSocket();
		await listen(manager, config, client);

		client.emit('error', new Error('reset'));
		client.emit('close');

		expect(pool.releaseConnection).toHaveBeenCalledTimes(1);
		expect(pool.releaseConnection).toHaveBeenCalledWith('C-1', 7);
	});
});

describe('ProxyManager data forwarding', () => {
	it('forwards transformed client data to the service', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);
		manager.setFromClientTransformer(() => (data) => Buffer.concat([Buffer.from('X'), data]));

		const client = new FakeSocket();
		await listen(manager, config, client);
		client.emit('data', Buffer.from('ping'));

		expect(serviceSocket.write).toHaveBeenCalledWith(Buffer.from('Xping'));
	});

	it('forwards the original buffer when the transformer throws', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);
		manager.setFromClientTransformer(() => () => {
			throw new Error('bad transform');
		});

		const client = new FakeSocket();
		await listen(manager, config, client);
		const payload = Buffer.from('ping');
		client.emit('data', payload);

		expect(serviceSocket.write).toHaveBeenCalledWith(payload);
	});
});

describe('ProxyManager backpressure (M5)', () => {
	it('pauses the client when the service write buffer is full and resumes on drain', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);

		const client = new FakeSocket();
		await listen(manager, config, client);

		serviceSocket.write.mockReturnValue(false); // destination buffer is full
		client.emit('data', Buffer.from('ping'));
		expect(client.pause).toHaveBeenCalledTimes(1);
		expect(client.resume).not.toHaveBeenCalled();

		serviceSocket.emit('drain');
		expect(client.resume).toHaveBeenCalledTimes(1);
	});
});

describe('ProxyManager client idle timeout (M6)', () => {
	it('closes an idle client after the configured timeout and releases the pooled connection', async () => {
		const config = makeConfig({ clientIdleTimeoutMs: 1000 });
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);

		const client = new FakeSocket();
		await listen(manager, config, client);

		expect(client.setTimeout).toHaveBeenCalledWith(1000, expect.any(Function));
		const onTimeout = client.setTimeout.mock.calls[0][1] as () => void;
		onTimeout();

		expect(client.end).toHaveBeenCalled();
		expect(pool.releaseConnection).toHaveBeenCalledWith('C-1', 7);
	});

	it('does not arm a timeout when the idle timeout is disabled (0)', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		primePool(pool, new FakeSocket());

		const client = new FakeSocket();
		await listen(manager, config, client);

		expect(client.setTimeout).not.toHaveBeenCalled();
	});
});

describe('ProxyManager destroy-on-dirty recycling (connection-state leak)', () => {
	it('destroys the pooled connection when the session left connection-scoped state', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		primePool(pool, new FakeSocket());
		manager.setFromClientTransformer((session: any) => {
			session[RECYCLE_UNSAFE_KEY] = true; // e.g. the client ran SELECT / SUBSCRIBE / left a MULTI open
			return (data: Buffer) => data;
		});

		const client = new FakeSocket();
		await listen(manager, config, client);
		client.emit('close');

		expect(pool.closeConnection).toHaveBeenCalledWith('C-1', 7);
		expect(pool.releaseConnection).not.toHaveBeenCalled();
	});

	it('recycles (releases) the pooled connection for a clean session', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		primePool(pool, new FakeSocket());

		const client = new FakeSocket();
		await listen(manager, config, client);
		client.emit('close');

		expect(pool.releaseConnection).toHaveBeenCalledWith('C-1', 7);
		expect(pool.closeConnection).not.toHaveBeenCalled();
	});
});

describe('ProxyManager service side termination', () => {
	it('ends the client and closes the pooled connection when the service socket closes', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		const serviceSocket = new FakeSocket();
		primePool(pool, serviceSocket);

		const client = new FakeSocket();
		await listen(manager, config, client);
		serviceSocket.emit('close');

		expect(client.end).toHaveBeenCalled();
		expect(pool.closeConnection).toHaveBeenCalledWith('C-1', 7);
	});
});

describe('ProxyManager reverse-proxy bind failure (#8)', () => {
	it('logs and emits failure when a proxy server errors, and drops it from the map', () => {
		const config = makeConfig({ portMapping: { 7000: 'tenant:' } });
		const manager = new ProxyManager(config);

		const failure = jest.fn();
		manager.on('failure', failure);
		manager.startServers();

		const proxy = (manager as unknown as { proxies: Map<string, EventEmitter> }).proxies.get('7000');
		expect(proxy).toBeDefined();
		// Attach a no-op extra listener so emitting 'error' never throws as an unhandled event.
		proxy!.emit('error', Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }));

		expect(failure).toHaveBeenCalledTimes(1);
		expect((manager as unknown as { proxies: Map<string, EventEmitter> }).proxies.has('7000')).toBe(false);
	});
});

describe('ProxyManager pool acquisition failure', () => {
	it('ends the client when no connection can be acquired', async () => {
		const config = makeConfig();
		const manager = new ProxyManager(config);
		const pool = poolInstances[0];
		pool.getConnection.mockResolvedValue(null);

		const client = new FakeSocket();
		await listen(manager, config, client);

		expect(client.end).toHaveBeenCalled();
	});
});
