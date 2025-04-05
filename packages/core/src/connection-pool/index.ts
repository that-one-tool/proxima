import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { ConnectionPoolError } from '../errors';
import { TlsServerClientOptions } from '../types';
import { makeTlsOptions, validateOptions } from '../utils/tls';
import { ConnectionStatus, ForwardServiceOptions, PoolConnection, PoolStats } from './types';

export class ConnectionPool extends EventEmitter {
	private options: Required<ForwardServiceOptions>;
	private tlsClientOptions: TlsServerClientOptions;
	private connections: Map<string, PoolConnection> = new Map();
	private waitingQueue: Array<(connection: PoolConnection | null) => void> = [];
	private cleanupTimer: NodeJS.Timeout | null = null;
	private connectionCounter = 0;
	private isWaitingToRetry = false;
	private retryCount = 0;
	private isShuttingDown = false;

	constructor(options: ForwardServiceOptions, tlsClientOptions: TlsServerClientOptions) {
		super();

		if (!options.host) {
			throw new ConnectionPoolError('Host is required');
		}

		if (!options.port) {
			throw new ConnectionPoolError('Port is required');
		}

		validateOptions(tlsClientOptions);

		this.options = {
			host: options.host,
			port: options.port,
			name: options.name || 'default',
			minPoolConnections: options.minPoolConnections ?? 0,
			maxPoolConnections: options.maxPoolConnections ?? 10,
			idleConnectionTimeoutMs: options.idleConnectionTimeoutMs ?? 30000,
			connectionCleanupIntervalMs: options.connectionCleanupIntervalMs ?? 30000,
			acquireConnectionTimeoutMs: options.acquireConnectionTimeoutMs ?? 5000,
			maxRetries: options.maxRetries ?? 3,
		};

		this.tlsClientOptions = tlsClientOptions;

		console.log(
			`Initializing ${this.tlsClientOptions.useTls ? 'TLS' : 'TCP'} connection pool to ${this.options.host}:${this.options.port}`,
		);
		void this.initialize();
	}

	/**
	 * Get an available connection or create a new one if needed
	 */
	async getConnection(): Promise<PoolConnection | null> {
		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				connection.status = ConnectionStatus.BUSY;
				connection.lastUsed = Date.now();
				return connection;
			}
		}

		if (this.connections.size < this.options.maxPoolConnections) {
			try {
				const connection = await this.createConnection();
				connection.status = ConnectionStatus.BUSY;
				return connection;
			} catch (error) {
				this.emit('error', new ConnectionPoolError('Failed to create new connection', { cause: error }));
			}
		}

		// Otherwise, wait for a connection
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				// Remove from waiting queue if timed out
				const index = this.waitingQueue.indexOf(callback);
				if (index !== -1) {
					this.waitingQueue.splice(index, 1);
				}
				resolve(null);
			}, this.options.acquireConnectionTimeoutMs);

			const callback = (connection: PoolConnection | null) => {
				clearTimeout(timeout);
				resolve(connection);
			};

			this.waitingQueue.push(callback);
		});
	}

	/**
	 * Release a connection back to the pool
	 */
	releaseConnection(connectionId: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		connection.status = ConnectionStatus.IDLE;
		connection.lastUsed = Date.now();

		// Check if there are waiting requests
		if (this.waitingQueue.length > 0) {
			const callback = this.waitingQueue.shift();
			if (callback) {
				connection.status = ConnectionStatus.BUSY;
				callback(connection);
			}
		}
	}

	/**
	 * Close a specific connection
	 */
	closeConnection(connectionId: string): void {
		this.removeConnection(connectionId);
	}

	/**
	 * Get current pool statistics
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
	 * Shut down the connection pool
	 */
	async shutdown(): Promise<void> {
		this.isShuttingDown = true;

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		for (const callback of this.waitingQueue) {
			callback(null);
		}

		this.waitingQueue = [];

		const closePromises: Promise<void>[] = [];

		for (const id of this.connections.keys()) {
			closePromises.push(
				new Promise<void>((resolve) => {
					this.removeConnection(id);
					resolve();
				}),
			);
		}

		await Promise.all(closePromises);

		this.emit('shutdown');
	}

	private async attemptReinitialization(): Promise<void> {
		try {
			await this.reinitializeMinConnections();
		} catch (error) {
			console.error(`Failed to reinitialize connections on retry ${this.retryCount}`, error);
			this.handleConnectionPoolError();
		}
	}

	private cleanupIdleConnections(): void {
		const now = Date.now();
		const idleThreshold = now - this.options.idleConnectionTimeoutMs;
		let idleCount = 0;

		// Count idle connections
		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				idleCount++;
			}
		}

		// Only remove idle connections if we have more than the minimum
		if (idleCount > this.options.minPoolConnections) {
			for (const [id, connection] of this.connections.entries()) {
				if (
					connection.status === ConnectionStatus.IDLE &&
					connection.lastUsed < idleThreshold &&
					idleCount > this.options.minPoolConnections
				) {
					this.removeConnection(id);
					idleCount--;
				}
			}
		}
	}

	private createConnection(): Promise<PoolConnection> {
		return new Promise((resolve, reject) => {
			try {
				const id = `C-${randomUUID().slice(24)}`;
				let socket: net.Socket;
				++this.connectionCounter;

				// Create either a TLS or TCP connection based on useTls flag
				if (this.tlsClientOptions.useTls) {
					if (!this.tlsClientOptions.tlsOptions) {
						throw new ConnectionPoolError('TLS options must be provided for TLS connection type');
					}

					const tlsOptions = makeTlsOptions(this.tlsClientOptions.tlsOptions);
					socket = tls.connect(this.options.port, this.options.host, tlsOptions);
				} else {
					socket = net.createConnection(this.options.port, this.options.host);
				}

				const connection: PoolConnection = {
					id,
					socket,
					status: ConnectionStatus.IDLE,
					lastUsed: Date.now(),
				};

				socket.once('connect', () => {
					this.connections.set(id, connection);
					this.emit('connection', { id, poolSize: this.connections.size });
					resolve(connection);
				});

				socket.on('error', (err: Error) => {
					if (!this.connections.has(id)) {
						reject(new ConnectionPoolError('Connection creation failed', { cause: err }));
						return;
					}

					this.emit('connectionError', { id, error: err });
					this.removeConnection(id);
				});

				socket.on('close', () => {
					if (this.connections.has(id)) {
						this.removeConnection(id);
					}
				});
			} catch (error) {
				reject(new ConnectionPoolError('Failed to create connection', { cause: error }));
			}
		});
	}

	private async createMultipleConnections(count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await this.createConnection();
		}
	}

	private handleConnectionPoolError(): void {
		const stats = this.getStats();
		const isConnectionPoolStateHealthy = stats.total >= stats.minConnections && !this.isShuttingDown;
		const isConnectionPoolStateDegraded = stats.total < stats.minConnections && !this.isShuttingDown;
		const canRetryRestoringConnectionPool = this.retryCount < this.options.maxRetries;

		if (!isConnectionPoolStateHealthy && !canRetryRestoringConnectionPool) {
			this.emit('connectionPoolFailure', new ConnectionPoolError('Failed to recover connection pool'));
			return;
		}

		if (isConnectionPoolStateDegraded && canRetryRestoringConnectionPool && !this.isWaitingToRetry) {
			this.retryCount++;
			this.isWaitingToRetry = true;
			const backoffDelay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);

			console.log(
				`Attempting to recover connection pool (retry ${this.retryCount}/${this.options.maxRetries}) after ${backoffDelay}ms`,
			);

			setTimeout(() => {
				console.log(`Retry ${this.retryCount}: Attempting to reinitialize connections`);
				void this.attemptReinitialization();
			}, backoffDelay);
		}
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

	private async reinitializeMinConnections(): Promise<void> {
		this.isWaitingToRetry = false;

		try {
			const currentCount = this.connections.size;
			const neededConnections = Math.max(0, this.options.minPoolConnections - currentCount);

			console.log(
				`Reinitializing connections. Current: ${currentCount}, Minimum required: ${this.options.minPoolConnections}, Creating: ${neededConnections}`,
			);

			await this.createMultipleConnections(neededConnections);

			this.retryCount = 0;
			console.log(`Successfully reinitialized connections. Current pool size: ${this.connections.size}`);
		} catch (error) {
			throw new ConnectionPoolError('Failed to reinitialize minimum connections', { cause: error });
		}
	}

	private removeConnection(connectionId: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		try {
			connection.status = ConnectionStatus.CLOSED;
			connection.socket.removeAllListeners();
			connection.socket.destroy();
			this.connections.delete(connectionId);

			this.emit('connectionClosed', { id: connectionId, poolSize: this.connections.size });

			if (this.connections.size < this.options.minPoolConnections && !this.isShuttingDown) {
				void this.createConnection().catch((error) => {
					this.emit('error', new ConnectionPoolError('Failed to create replacement connection', { cause: error }));

					if (this.connections.size === 0) {
						this.handleConnectionPoolError();
					}
				});
			}
		} catch (error) {
			this.emit(
				'error',
				new ConnectionPoolError('Error removing connection', {
					cause: error,
					context: { connectionId },
				}),
			);
		}
	}

	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupIdleConnections();
		}, this.options.connectionCleanupIntervalMs);
	}
}
