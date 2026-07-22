/// <reference types="jest" />
import { EventEmitter } from 'node:events';

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

const createdSockets: FakeSocket[] = [];
let autoConnect = true;

class FakeSocket extends EventEmitter {
	destroyed = false;
	write = jest.fn();
	end = jest.fn();
	setTimeout = jest.fn();
	pause = jest.fn();
	resume = jest.fn();
	destroy = jest.fn(() => {
		this.destroyed = true;
		this.emit('close');
	});
}

jest.mock('node:net', () => ({
	createConnection: jest.fn(() => {
		const socket = new FakeSocket();
		createdSockets.push(socket);
		if (autoConnect) {
			setImmediate(() => socket.emit('connect'));
		}
		return socket;
	}),
}));

import { ConnectionPool } from '../../src/connection-pool';
import { ConnectionStatus, ForwardServiceOptions } from '../../src/connection-pool/types';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const pools: ConnectionPool[] = [];

function makePool(overrides: Partial<ForwardServiceOptions> = {}): ConnectionPool {
	const pool = new ConnectionPool(
		{
			host: 'localhost',
			port: 6379,
			name: 'test',
			minPoolConnections: 0,
			maxPoolConnections: 2,
			acquireConnectionTimeoutMs: 30,
			connectionTimeoutMs: 30,
			connectionCleanupIntervalMs: 60000,
			...overrides,
		},
		{ useTls: false },
	);
	pool.on('error', () => undefined);
	pools.push(pool);
	return pool;
}

beforeEach(() => {
	createdSockets.length = 0;
	autoConnect = true;
	jest.clearAllMocks();
});

afterEach(async () => {
	await Promise.all(pools.map((pool) => pool.shutdown()));
	pools.length = 0;
});

describe('ConnectionPool constructor validation', () => {
	it('rejects a port outside the valid range', () => {
		expect(() => makePool({ port: 70000 })).toThrow('range');
	});

	it('rejects a minimum pool size greater than the maximum', () => {
		expect(() => makePool({ minPoolConnections: 5, maxPoolConnections: 2 })).toThrow();
	});
});

describe('ConnectionPool double release (Bug #2)', () => {
	it('is idempotent when the same lease is released twice', async () => {
		const pool = makePool();
		const connection = await pool.getConnection();
		expect(connection).not.toBeNull();

		const leaseId = connection!.leaseId;
		pool.releaseConnection(connection!.id, leaseId);
		pool.releaseConnection(connection!.id, leaseId);

		expect(connection!.status).toBe(ConnectionStatus.IDLE);
		expect(pool.getStats().idle).toBe(1);
		expect(pool.getStats().busy).toBe(0);
	});

	it('does not hand a stale release to a new waiter', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const first = await pool.getConnection();
		const staleLease = first!.leaseId;

		const waiterPromise = pool.getConnection();
		await flush();

		pool.releaseConnection(first!.id, staleLease);
		const waiter = await waiterPromise;
		expect(waiter).not.toBeNull();

		pool.releaseConnection(first!.id, staleLease);

		expect(waiter!.status).toBe(ConnectionStatus.BUSY);
		expect(pool.getStats().busy).toBe(1);
	});
});

describe('ConnectionPool max pool size (Bug #3)', () => {
	it('never exceeds maxPoolConnections under concurrent acquisition', async () => {
		const pool = makePool({ maxPoolConnections: 2 });

		const results = await Promise.all([pool.getConnection(), pool.getConnection(), pool.getConnection(), pool.getConnection()]);

		expect(pool.getStats().total).toBeLessThanOrEqual(2);
		expect(createdSockets.length).toBeLessThanOrEqual(2);
		expect(results.filter((connection) => connection !== null)).toHaveLength(2);
	});
});

describe('ConnectionPool connect timeout (Bug #4)', () => {
	it('times out and destroys the socket when connect never completes', async () => {
		autoConnect = false;
		const pool = makePool({ maxPoolConnections: 1, connectionTimeoutMs: 10, acquireConnectionTimeoutMs: 10 });

		const result = await pool.getConnection();

		expect(result).toBeNull();
		expect(createdSockets.length).toBeGreaterThan(0);
		expect(createdSockets[0].destroy).toHaveBeenCalled();
	});
});

describe('ConnectionPool waiting queue cap (Bug #6)', () => {
	it('fails fast once the waiting queue is full', async () => {
		const pool = makePool({ maxPoolConnections: 1, maxWaitingQueueSize: 1, acquireConnectionTimeoutMs: 20 });
		const held = await pool.getConnection();
		expect(held).not.toBeNull();

		const firstWaiter = pool.getConnection();
		await flush();
		const overflow = await pool.getConnection();

		expect(overflow).toBeNull();
		await firstWaiter;
	});
});

describe('ConnectionPool idle cleanup', () => {
	it('never evicts below the minimum pool size', async () => {
		const pool = makePool({ minPoolConnections: 1, maxPoolConnections: 3, idleConnectionTimeoutMs: 0 });
		await new Promise((resolve) => pool.once('ready', resolve));

		(pool as unknown as { cleanupIdleConnections: () => void }).cleanupIdleConnections();

		expect(pool.getStats().total).toBe(1);
	});
});

describe('ConnectionPool lease teardown (Bug #1)', () => {
	it('strips listeners attached through the lease when the connection is released', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const leased = await pool.getConnection();
		expect(leased).not.toBeNull();

		const socket = createdSockets[0];
		const before = socket.listenerCount('data');
		leased!.on('data', () => undefined);
		expect(socket.listenerCount('data')).toBe(before + 1);

		pool.releaseConnection(leased!.id, leased!.leaseId);
		expect(socket.listenerCount('data')).toBe(before);
	});

	it('reuses the same socket with no leftover listeners across leases', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const first = await pool.getConnection();
		const socket = createdSockets[0];
		first!.on('data', () => undefined);
		first!.on('close', () => undefined);
		pool.releaseConnection(first!.id, first!.leaseId);

		const second = await pool.getConnection();
		expect(second!.id).toBe(first!.id);
		expect(socket.listenerCount('data')).toBe(0);

		second!.on('data', () => undefined);
		expect(socket.listenerCount('data')).toBe(1);
	});
});

describe('ConnectionPool release requires a matching lease', () => {
	it('ignores a release with a wrong lease id', async () => {
		const pool = makePool();
		const connection = await pool.getConnection();

		pool.releaseConnection(connection!.id, connection!.leaseId + 999);

		expect(connection!.status).toBe(ConnectionStatus.BUSY);
	});
});

describe('ConnectionPool close requires a matching lease (#6)', () => {
	it('ignores a close with a stale lease id and keeps the connection', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const connection = await pool.getConnection();
		const socket = createdSockets[0];

		pool.closeConnection(connection!.id, connection!.leaseId + 999);

		expect(socket.destroy).not.toHaveBeenCalled();
		expect(connection!.status).toBe(ConnectionStatus.BUSY);
	});

	it('closes the connection when the lease id matches', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const connection = await pool.getConnection();
		const socket = createdSockets[0];

		pool.closeConnection(connection!.id, connection!.leaseId);

		expect(socket.destroy).toHaveBeenCalled();
	});

	it('still closes unconditionally when no lease id is given', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const connection = await pool.getConnection();
		const socket = createdSockets[0];

		pool.closeConnection(connection!.id);

		expect(socket.destroy).toHaveBeenCalled();
	});
});

describe('LeasedConnection write after detach (#6)', () => {
	it('drops writes once the lease has been released', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const leased = await pool.getConnection();
		const socket = createdSockets[0];

		pool.releaseConnection(leased!.id, leased!.leaseId); // detaches the lease

		expect(leased!.write(Buffer.from('late'))).toBe(false);
		expect(socket.write).not.toHaveBeenCalled();
	});

	it('writes normally while the lease is active', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const leased = await pool.getConnection();
		const socket = createdSockets[0];
		socket.write.mockReturnValue(true);

		expect(leased!.write(Buffer.from('hi'))).toBe(true);
		expect(socket.write).toHaveBeenCalledWith(Buffer.from('hi'));
	});
});

describe('LeasedConnection pause/resume for backpressure (M5)', () => {
	it('delegates pause/resume to the socket while active and no-ops once detached', async () => {
		const pool = makePool({ maxPoolConnections: 1 });
		const leased = await pool.getConnection();
		const socket = createdSockets[0];

		leased!.pause();
		leased!.resume();
		expect(socket.pause).toHaveBeenCalledTimes(1);
		expect(socket.resume).toHaveBeenCalledTimes(1);

		pool.releaseConnection(leased!.id, leased!.leaseId); // detaches the lease

		leased!.pause();
		leased!.resume();
		expect(socket.pause).toHaveBeenCalledTimes(1);
		expect(socket.resume).toHaveBeenCalledTimes(1);
	});
});
