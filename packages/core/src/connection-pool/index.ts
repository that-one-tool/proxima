import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Config } from '../configuration';
import { ConnectionPoolError } from '../errors';
import { ConnectionPoolOptions, ConnectionStatus, PoolConnection, PoolStats } from './types';

export class ConnectionPool extends EventEmitter {
	private config: Config;
	private options: Required<ConnectionPoolOptions>;
	private connections: Map<string, PoolConnection> = new Map();
	private waitingQueue: Array<(connection: PoolConnection | null) => void> = [];
	private cleanupTimer: NodeJS.Timeout | null = null;
	private connectionCounter = 0;

	constructor(config: Config, options: ConnectionPoolOptions = {}) {
		super();
		this.config = config;

		this.options = {
			minConnections: options.minConnections ?? 5,
			maxConnections: options.maxConnections ?? 20,
			idleTimeoutMs: options.idleTimeoutMs ?? 30000,
			cleanupIntervalMs: options.cleanupIntervalMs ?? 30000,
			acquireTimeoutMs: options.acquireTimeoutMs ?? 5000,
		};

		void this.initialize();
	}

	private async initialize(): Promise<void> {
		try {
			// Create minimum connections
			for (let i = 0; i < this.options.minConnections; i++) {
				await this.createConnection();
			}

			this.startCleanup();

			this.emit('ready');
		} catch (error) {
			this.emit('error', new ConnectionPoolError('Failed to initialize connection pool', { cause: error }));
		}
	}

	/**
	 * Create a new connection
	 */
	private createConnection(): Promise<PoolConnection> {
		return new Promise((resolve, reject) => {
			try {
				const id = `C-${randomUUID().slice(24)}`;
				const socket = net.createConnection(this.config.forwardPort, this.config.forwardHost);
				++this.connectionCounter;

				const connection: PoolConnection = {
					id,
					socket,
					status: ConnectionStatus.IDLE,
					lastUsed: Date.now(),
				};

				// Set up socket event handlers
				socket.once('connect', () => {
					this.connections.set(id, connection);
					this.emit('connection', { id, poolSize: this.connections.size });
					resolve(connection);
				});

				socket.on('error', (err: Error) => {
					if (!this.connections.has(id)) {
						// Connection failed during creation
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

	/**
	 * Get an available connection or create a new one if needed
	 */
	async getConnection(): Promise<PoolConnection | null> {
		// Find an idle connection
		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				connection.status = ConnectionStatus.BUSY;
				connection.lastUsed = Date.now();
				return connection;
			}
		}

		// Create a new connection if below max limit
		if (this.connections.size < this.options.maxConnections) {
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
			}, this.options.acquireTimeoutMs);

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
	 * Remove a connection from the pool
	 */
	private removeConnection(connectionId: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		try {
			connection.status = ConnectionStatus.CLOSED;
			connection.socket.removeAllListeners();
			connection.socket.destroy();
			this.connections.delete(connectionId);

			this.emit('connectionClosed', { id: connectionId, poolSize: this.connections.size });

			// Create a new connection if below minimum and not shutting down
			if (this.connections.size < this.options.minConnections && this.cleanupTimer !== null) {
				void this.createConnection().catch((error) => {
					this.emit('error', new ConnectionPoolError('Failed to create replacement connection', { cause: error }));
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

	/**
	 * Close a specific connection
	 */
	closeConnection(connectionId: string): void {
		this.removeConnection(connectionId);
	}

	/**
	 * Start periodic cleanup of idle connections
	 */
	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupIdleConnections();
		}, this.options.cleanupIntervalMs);
	}

	/**
	 * Clean up idle connections that exceed the idle timeout
	 */
	private cleanupIdleConnections(): void {
		const now = Date.now();
		const idleThreshold = now - this.options.idleTimeoutMs;
		let idleCount = 0;

		// Count idle connections
		for (const connection of this.connections.values()) {
			if (connection.status === ConnectionStatus.IDLE) {
				idleCount++;
			}
		}

		// Only remove idle connections if we have more than the minimum
		if (idleCount > this.options.minConnections) {
			for (const [id, connection] of this.connections.entries()) {
				if (
					connection.status === ConnectionStatus.IDLE &&
					connection.lastUsed < idleThreshold &&
					idleCount > this.options.minConnections
				) {
					this.removeConnection(id);
					idleCount--;
				}
			}
		}
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
			maxConnections: this.options.maxConnections,
			minConnections: this.options.minConnections,
		};
	}

	/**
	 * Reinitialize connections to meet the minimum connection requirement
	 * This is used to recover from connection failures
	 */
	async reinitializeMinConnections(): Promise<void> {
		try {
			const currentCount = this.connections.size;
			const neededConnections = Math.max(0, this.options.minConnections - currentCount);

			console.log(
				`Reinitializing connections. Current: ${currentCount}, Minimum required: ${this.options.minConnections}, Creating: ${neededConnections}`,
			);

			// Create new connections to meet the minimum requirement
			for (let i = 0; i < neededConnections; i++) {
				await this.createConnection();
			}

			console.log(`Successfully reinitialized connections. Current pool size: ${this.connections.size}`);
		} catch (error) {
			throw new ConnectionPoolError('Failed to reinitialize minimum connections', { cause: error });
		}
	}

	/**
	 * Shut down the connection pool
	 */
	async shutdown(): Promise<void> {
		// Stop cleanup timer
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Resolve any waiting clients with null
		for (const callback of this.waitingQueue) {
			callback(null);
		}
		this.waitingQueue = [];

		// Close all connections
		const closePromises: Promise<void>[] = [];

		for (const id of this.connections.keys()) {
			// Create a promise for each connection closure
			closePromises.push(
				new Promise<void>((resolve) => {
					this.removeConnection(id);
					resolve();
				}),
			);
		}

		// Wait for all connections to close
		await Promise.all(closePromises);

		this.emit('shutdown');
	}
}
