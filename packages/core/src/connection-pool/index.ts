import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { ConnectionPoolError } from '../errors';
import { Logger } from '../logging';
import { TlsServerClientOptions } from '../types';
import { makeTlsOptions, validateTlsOptions } from '../utils/tls';
import { LeasedConnection } from './leased-connection';
import { ConnectionStatus, ForwardServiceOptions, PoolConnection, PoolStats } from './types';

const DEFAULT_MIN_POOL_CONNECTIONS = 0;
const DEFAULT_MAX_POOL_CONNECTIONS = 10;
const DEFAULT_IDLE_CONNECTION_TIMEOUT_MS = 30000;
const DEFAULT_CONNECTION_CLEANUP_INTERVAL_MS = 30000;
const DEFAULT_ACQUIRE_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_MAX_WAITING_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRIES = 3;
const CREATE_ATTEMPTS = 2;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const SHORT_ID_START = 24; // last hex group of a v4 UUID, used as a short readable connection id
const UNLEASED = 0;

export class ConnectionPool extends EventEmitter {
	private options: Required<ForwardServiceOptions>;
	private tlsClientOptions: TlsServerClientOptions;
	private connections: Map<string, PoolConnection> = new Map();
	private waitingQueue: Array<(connection: LeasedConnection | null) => void> = [];
	private cleanupTimer: NodeJS.Timeout | null = null;
	private pendingConnections = 0;
	private leaseCounter = 0;
	private isWaitingToRetry = false;
	private retryCount = 0;
	private isShuttingDown = false;
	private logger: Logger;

	constructor(options: ForwardServiceOptions, tlsClientOptions: TlsServerClientOptions) {
		super();

		if (!options.host) {
			throw new ConnectionPoolError('Host is required');
		}

		if (!options.port) {
			throw new ConnectionPoolError('Port is required');
		}

		if (options.port < MIN_PORT || options.port > MAX_PORT) {
			throw new ConnectionPoolError('Port is out of range', { context: { port: options.port } });
		}

		validateTlsOptions(tlsClientOptions);
		this.tlsClientOptions = tlsClientOptions;

		this.options = {
			host: options.host,
			port: options.port,
			name: options.name || 'default',
			minPoolConnections: options.minPoolConnections ?? DEFAULT_MIN_POOL_CONNECTIONS,
			maxPoolConnections: options.maxPoolConnections ?? DEFAULT_MAX_POOL_CONNECTIONS,
			idleConnectionTimeoutMs: options.idleConnectionTimeoutMs ?? DEFAULT_IDLE_CONNECTION_TIMEOUT_MS,
			connectionCleanupIntervalMs: options.connectionCleanupIntervalMs ?? DEFAULT_CONNECTION_CLEANUP_INTERVAL_MS,
			acquireConnectionTimeoutMs: options.acquireConnectionTimeoutMs ?? DEFAULT_ACQUIRE_CONNECTION_TIMEOUT_MS,
			connectionTimeoutMs: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
			maxWaitingQueueSize: options.maxWaitingQueueSize ?? DEFAULT_MAX_WAITING_QUEUE_SIZE,
			maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
		};

		if (this.options.minPoolConnections > this.options.maxPoolConnections) {
			throw new ConnectionPoolError('minPoolConnections cannot exceed maxPoolConnections', {
				context: { min: this.options.minPoolConnections, max: this.options.maxPoolConnections },
			});
		}

		this.logger = Logger.getInstance();

		this.logger.info(
			`[ConnectionPool] Initializing ${this.tlsClientOptions.useTls ? 'TLS' : 'TCP'} connection pool to ${this.options.host}:${this.options.port}`,
		);
		void this.initialize();
	}

	/**
	 * Close a specific connection.
	 *
	 * @param {string} connectionId The id of the connection to close
	 * @param {number} [leaseId] When given, close only if the connection still carries this lease.
	 *   This mirrors {@link releaseConnection}'s guard so a caller holding a stale id cannot tear down
	 *   a connection that has since been recycled and re-leased to a different client.
	 */
	closeConnection(connectionId: string, leaseId?: number): void {
		if (leaseId !== undefined) {
			const connection = this.connections.get(connectionId);
			if (!connection || connection.leaseId !== leaseId) {
				return;
			}
		}
		this.removeConnection(connectionId);
	}

	/**
	 * Get an available connection or create a new one if needed
	 *
	 * @returns {Promise<LeasedConnection | null>} A promise resolving to a leased connection or null
	 */
	async getConnection(): Promise<LeasedConnection | null> {
		const idle = this.acquireIdleConnection();
		if (idle) {
			return idle;
		}

		const created = await this.createLeasedConnectionIfRoom();
		if (created) {
			return created;
		}

		return this.waitForConnection();
	}

	/**
	 * Get current pool statistics
	 *
	 * @returns {PoolStats} The connection pool stats
	 */
	getStats(): PoolStats {
		let idle = 0;
		let busy = 0;

		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				idle++;
			} else if (connection.status === ConnectionStatus.BUSY) {
				busy++;
			}
		}

		return {
			total: this.connections.size,
			idle,
			busy,
			waiting: this.waitingQueue.length,
			maxConnections: this.options.maxPoolConnections,
			minConnections: this.options.minPoolConnections,
		};
	}

	/**
	 * Release a connection back to the pool
	 *
	 * @param {string} connectionId The id of the connection to release
	 * @param {number} leaseId The lease token the connection was handed out with
	 */
	releaseConnection(connectionId: string, leaseId: number): void {
		const connection = this.connections.get(connectionId);
		if (!connection || connection.leaseId !== leaseId) {
			return;
		}

		connection.lease?.detach();
		connection.lease = undefined;
		connection.status = ConnectionStatus.IDLE;
		connection.lastUsed = Date.now();
		connection.leaseId = UNLEASED;

		this.serveNextWaiter();
	}

	/**
	 * Shut down the connection pool
	 */
	shutdown(): Promise<void> {
		this.isShuttingDown = true;

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		this.rejectAllWaiters();

		for (const id of [...this.connections.keys()]) {
			this.removeConnection(id);
		}

		this.emit('shutdown');
		return Promise.resolve();
	}

	private acquireIdleConnection(): LeasedConnection | null {
		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				return this.leaseConnection(connection);
			}
		}

		return null;
	}

	private async attemptReinitialization(): Promise<void> {
		if (this.isShuttingDown) {
			return;
		}

		try {
			await this.reinitializeMinConnections();
		} catch (error) {
			this.logger.error(`[ConnectionPool] Failed to reinitialize connections on retry ${this.retryCount}`, { error });
			this.handleConnectionPoolError();
		}
	}

	private cleanupIdleConnections(): void {
		const idleThreshold = Date.now() - this.options.idleConnectionTimeoutMs;
		const evictable: string[] = [];

		for (const [id, connection] of this.connections.entries()) {
			if (connection.status === ConnectionStatus.IDLE && connection.lastUsed < idleThreshold) {
				evictable.push(id);
			}
		}

		this.evictDownToMinimum(evictable);
	}

	private computeBackoffDelay(): number {
		return Math.min(BACKOFF_BASE_MS * Math.pow(2, this.retryCount), MAX_BACKOFF_MS);
	}

	private createConnection(): Promise<PoolConnection> {
		this.pendingConnections++;
		return this.openConnection().finally(() => {
			this.pendingConnections--;
		});
	}

	private createLeasedConnectionIfRoom(): Promise<LeasedConnection | null> {
		return this.createWithRetry(CREATE_ATTEMPTS);
	}

	private async createWithRetry(attempts: number): Promise<LeasedConnection | null> {
		for (let attempt = 0; attempt < attempts && this.hasRoomForNewConnection(); attempt++) {
			const connection = await this.tryCreateConnection();
			if (connection) {
				return this.leaseConnection(connection);
			}
		}

		return null;
	}

	private createSocket(): net.Socket {
		if (!this.tlsClientOptions.useTls) {
			return net.createConnection(this.options.port, this.options.host);
		}

		if (!this.tlsClientOptions.tlsOptions) {
			throw new ConnectionPoolError('TLS options must be provided for TLS connection type');
		}

		const tlsOptions = makeTlsOptions(this.tlsClientOptions.tlsOptions);
		return tls.connect(this.options.port, this.options.host, tlsOptions);
	}

	private buildConnection(): PoolConnection {
		return {
			id: `C-${randomUUID().slice(SHORT_ID_START)}`,
			socket: this.createSocket(),
			status: ConnectionStatus.IDLE,
			lastUsed: Date.now(),
			leaseId: UNLEASED,
		};
	}

	private async createMultipleConnections(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await this.createConnection();
		}
	}

	private destroyConnection(connectionId: string, connection: PoolConnection): void {
		try {
			connection.status = ConnectionStatus.CLOSED;
			connection.lease?.detach();
			connection.lease = undefined;
			connection.socket.removeAllListeners();
			connection.socket.destroy();
			this.connections.delete(connectionId);

			this.emit('connectionClosed', { id: connectionId, poolSize: this.connections.size });
		} catch (error) {
			this.emit('error', new ConnectionPoolError('Error removing connection', { cause: error, context: { connectionId } }));
		}
	}

	private evictDownToMinimum(evictable: string[]): void {
		let removable = this.connections.size - this.options.minPoolConnections;

		for (const id of evictable) {
			if (removable <= 0) {
				return;
			}

			this.removeConnection(id);
			removable--;
		}
	}

	private handleConnectionPoolError(): void {
		if (this.isShuttingDown) {
			return;
		}

		if (this.getStats().total >= this.options.minPoolConnections) {
			return;
		}

		this.scheduleRecovery();
	}

	private hasRoomForNewConnection(): boolean {
		return this.connections.size + this.pendingConnections < this.options.maxPoolConnections;
	}

	private async initialize(): Promise<void> {
		try {
			await this.createMultipleConnections(this.options.minPoolConnections);

			this.startCleanup();

			this.emit('ready');
		} catch (error) {
			this.emit('error', new ConnectionPoolError('Failed to initialize connection pool', { cause: error }));
			this.handleConnectionPoolError();
		}
	}

	private leaseConnection(connection: PoolConnection): LeasedConnection {
		connection.status = ConnectionStatus.BUSY;
		connection.lastUsed = Date.now();
		connection.leaseId = ++this.leaseCounter;
		connection.lease = new LeasedConnection(connection);
		return connection.lease;
	}

	private notifyIfRetriesExhausted(): void {
		if (this.retryCount === this.options.maxRetries + 1) {
			this.emit('connectionPoolFailure', new ConnectionPoolError('Failed to recover connection pool'));
		}
	}

	private openConnection(): Promise<PoolConnection> {
		return new Promise((resolve, reject) => {
			try {
				const connection = this.buildConnection();
				this.wireConnectionLifecycle(connection, resolve, reject);
			} catch (error) {
				reject(new ConnectionPoolError('Failed to create connection', { cause: error }));
			}
		});
	}

	private registerConnection(connection: PoolConnection): void {
		this.connections.set(connection.id, connection);
		this.emit('connection', { id: connection.id, poolSize: this.connections.size });
	}

	private reinitializeMinConnections(): Promise<void> {
		this.isWaitingToRetry = false;

		const currentCount = this.connections.size;
		const neededConnections = Math.max(0, this.options.minPoolConnections - currentCount);

		this.logger.info(
			`[ConnectionPool] Reinitializing connections. Current: ${currentCount}, Minimum required: ${this.options.minPoolConnections}, Creating: ${neededConnections}`,
		);

		return this.createMultipleConnections(neededConnections).then(() => {
			this.retryCount = 0;
			this.logger.info(`[ConnectionPool] Successfully reinitialized connections. Current pool size: ${this.connections.size}`);
		});
	}

	private rejectAllWaiters(): void {
		for (const callback of this.waitingQueue) {
			callback(null);
		}

		this.waitingQueue = [];
	}

	private removeConnection(connectionId: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}

		this.destroyConnection(connectionId, connection);
		this.replenishIfBelowMinimum();
	}

	private removeWaiter(callback: (connection: LeasedConnection | null) => void): void {
		const index = this.waitingQueue.indexOf(callback);
		if (index !== -1) {
			this.waitingQueue.splice(index, 1);
		}
	}

	private replenishIfBelowMinimum(): void {
		if (this.isShuttingDown || this.connections.size >= this.options.minPoolConnections) {
			return;
		}

		this.handleConnectionPoolError();
	}

	private scheduleRecovery(): void {
		if (this.isWaitingToRetry) {
			return;
		}

		this.isWaitingToRetry = true;
		this.retryCount++;
		this.notifyIfRetriesExhausted();

		const backoffDelay = this.computeBackoffDelay();
		this.logger.info(`[ConnectionPool] Scheduling recovery attempt ${this.retryCount} after ${backoffDelay}ms`);

		setTimeout(() => {
			void this.attemptReinitialization();
		}, backoffDelay);
	}

	private serveNextWaiter(): void {
		if (this.waitingQueue.length === 0) {
			return;
		}

		const connection = this.acquireIdleConnection();
		if (!connection) {
			return;
		}

		const callback = this.waitingQueue.shift();
		if (callback) {
			callback(connection);
		}
	}

	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupIdleConnections();
		}, this.options.connectionCleanupIntervalMs);
	}

	private tryCreateConnection(): Promise<PoolConnection | null> {
		return this.createConnection().catch((error) => {
			this.emit('error', new ConnectionPoolError('Failed to create new connection', { cause: error }));
			return null;
		});
	}

	private waitForConnection(): Promise<LeasedConnection | null> {
		if (this.waitingQueue.length >= this.options.maxWaitingQueueSize) {
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.removeWaiter(callback);
				resolve(null);
			}, this.options.acquireConnectionTimeoutMs);

			const callback = (connection: LeasedConnection | null) => {
				clearTimeout(timeout);
				resolve(connection);
			};

			this.waitingQueue.push(callback);
		});
	}

	private wireConnectionLifecycle(
		connection: PoolConnection,
		resolve: (connection: PoolConnection) => void,
		reject: (error: Error) => void,
	): void {
		const socket = connection.socket;

		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ConnectionPoolError('Connection attempt timed out', { context: { host: this.options.host, port: this.options.port } }));
		}, this.options.connectionTimeoutMs);

		socket.once('connect', () => {
			clearTimeout(timer);
			this.registerConnection(connection);
			resolve(connection);
		});

		socket.on('error', (err: Error) => {
			clearTimeout(timer);
			this.handleSocketError(connection.id, err, reject);
		});

		socket.on('close', () => {
			if (this.connections.has(connection.id)) {
				this.removeConnection(connection.id);
			}
		});
	}

	private handleSocketError(id: string, err: Error, reject: (error: Error) => void): void {
		if (!this.connections.has(id)) {
			reject(new ConnectionPoolError('Connection creation failed', { cause: err }));
			return;
		}

		this.emit('connectionError', { id, error: err });
		this.removeConnection(id);
	}
}
