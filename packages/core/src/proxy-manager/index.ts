import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Config } from '../configuration';
import { ConnectionPool } from '../connection-pool';
import { ConnectionPoolOptions } from '../connection-pool/types';
import { ContextualError } from '../errors';
import { TransformFunction } from '../types';

export class ProxyManager {
	private config: Config;
	private transformFromClient: TransformFunction;
	private transformToClient: TransformFunction;
	private serviceConnectionPool: ConnectionPool;
	private retryCount = 0;
	private maxRetries = 5;
	private isShuttingDown = false;

	private readonly proxies: Map<string, net.Server> = new Map();

	constructor(config: Config, poolOptions?: ConnectionPoolOptions) {
		this.config = config;
		this.serviceConnectionPool = this.initializeServiceConnectionPool(poolOptions);
	}

	initializeServiceConnectionPool(poolOptions?: ConnectionPoolOptions): ConnectionPool {
		const connectionPool = new ConnectionPool(
			this.config,
			poolOptions || {
				minConnections: 5,
				maxConnections: 20,
				idleTimeoutMs: 30000,
			},
		);

		connectionPool.on('ready', () => {
			console.log('Connection pool ready');
			// Reset retry count when pool becomes ready
			this.retryCount = 0;
		});

		connectionPool.on('error', (error) => {
			console.error('Connection pool error', error);
			this.handleConnectionPoolError();
		});

		connectionPool.on('connection', (data) => {
			console.log('New connection created in pool', data);
		});

		connectionPool.on('connectionClosed', (data) => {
			console.log('Connection closed in pool', data);
		});

		return connectionPool;
	}

	private handleConnectionPoolError(): void {
		const stats = this.serviceConnectionPool.getStats();

		// Implement a retry with exponential backoff before exiting
		if (stats.total <= stats.minConnections && !this.isShuttingDown) {
			if (this.retryCount < this.maxRetries) {
				this.retryCount++;
				const backoffDelay = Math.min(1000 * Math.pow(2, this.retryCount), 30000); // Cap at 30 seconds

				console.log(`Attempting to recover connection pool (retry ${this.retryCount}/${this.maxRetries}) after ${backoffDelay}ms`);

				setTimeout(() => {
					console.log(`Retry ${this.retryCount}: Attempting to reinitialize connections`);
					void this.attemptReinitialization();
				}, backoffDelay);
			} else {
				console.error(`Maximum retries (${this.maxRetries}) reached. Shutting down...`);
				this.stopServers();
				process.exit(1);
			}
		}
	}

	private async attemptReinitialization(): Promise<void> {
		try {
			await this.serviceConnectionPool.reinitializeMinConnections();
		} catch (error) {
			console.error(`Failed to reinitialize connections on retry ${this.retryCount}`, error);
			this.handleConnectionPoolError();
		}
	}

	setTransformFromClient(transformFromClient: TransformFunction): void {
		this.transformFromClient = transformFromClient;
	}

	setTransformToClient(transformToClient: TransformFunction): void {
		this.transformToClient = transformToClient;
	}

	startServers(): void {
		for (const [port, mapping] of Object.entries(this.config.portMapping)) {
			const proxy = this.createServer(this.config, parseInt(port, 10), mapping);

			proxy.listen(port, () => {
				console.log('=> Linked reverse proxy listening', { port, mapping });
			});

			this.proxies.set(port, proxy);
		}
	}

	stopServers(): void {
		this.isShuttingDown = true;
		const ports = new Set<string>(this.proxies.keys());

		for (const port of ports) {
			this.stopServer(port);
		}

		void this.serviceConnectionPool.shutdown().catch((error) => {
			console.error('Error shutting down connection pool', error);
		});
	}

	private createServer(config: Config, port: number, mapping: string) {
		return net.createServer((clientSocket) => {
			void this.listenConnection(config, clientSocket, port, mapping);
		});
	}

	private isClientAllowedToConnect(config: Config, clientIp: string | undefined) {
		const isBlacklisted = clientIp && config.ipBlacklist.includes(clientIp);
		const isWhitelisted = clientIp && (config.ipWhitelist.includes(clientIp) || config.ipWhitelist.includes('*.*.*.*'));
		return clientIp && !isBlacklisted && isWhitelisted;
	}

	private async listenConnection(config: Config, clientSocket: net.Socket, port: number, mapping: string) {
		const requestId = randomUUID();
		const clientIp = clientSocket.remoteAddress?.replace('::ffff:', '');

		console.log('Client connection opened', { clientIp, port, mapping, requestId });

		if (!this.isClientAllowedToConnect(config, clientIp)) {
			console.warn('Client is not allowed to connect. Closing connection.', { requestId });
			clientSocket.end();
			return;
		}

		console.log('Client connected', { requestId });

		try {
			const serviceConnexion = await this.serviceConnectionPool.getConnection();

			if (!serviceConnexion) {
				console.error('Failed to acquire a connection from pool', { requestId });
				clientSocket.end();
				return;
			}

			const connectionId = serviceConnexion.id;
			const serviceSocket = serviceConnexion.socket;

			console.log('Using pooled connection to service for client', { requestId, connectionId });

			// Handle sockets data
			clientSocket.on('data', (data: Buffer) => {
				console.log('Received original data from client for service', { requestId });
				let dataToForward = data;

				if (this.transformFromClient) {
					dataToForward = this.transformFromClient(data, mapping);
					console.log('Data from client transformed', { requestId });
				}

				serviceSocket.write(dataToForward);
				console.log('Data sent to service for client', { requestId });
			});

			serviceSocket.on('data', (data: Buffer) => {
				console.log('Received data from service for client', { requestId });
				let dataToForward = data;

				if (this.transformToClient) {
					dataToForward = this.transformToClient(data, mapping);
					console.log('Data from service transformed', { requestId });
				}

				clientSocket.write(dataToForward);
				console.log('Data sent to client for service', { requestId });
			});

			// Handle sockets close
			clientSocket.on('close', () => {
				console.log('Client connection closed', { requestId });
				this.serviceConnectionPool.releaseConnection(connectionId);
			});

			serviceSocket.on('close', () => {
				console.log('Service connection for client closed', { requestId });
				clientSocket.end();
				this.serviceConnectionPool.closeConnection(connectionId);
			});

			// Handle sockets errors
			clientSocket.on('error', (err) => {
				console.error('Client socket error', new ContextualError('Client socket error', { cause: err, context: { requestId } }));
				this.serviceConnectionPool.releaseConnection(connectionId);
			});

			serviceSocket.on('error', (err) => {
				console.error('Service socket error', new ContextualError('Service socket error', { cause: err, context: { requestId } }));
				clientSocket.end();
				this.serviceConnectionPool.closeConnection(connectionId);
			});
		} catch (error) {
			console.error(
				'Failed to establish connection',
				new ContextualError('Connection setup error', { cause: error, context: { requestId } }),
			);
			clientSocket.end();
		}
	}

	private stopServer(port: string): void {
		const proxy = this.proxies.get(port);

		proxy?.close((error) => {
			if (error) {
				console.error('An error occured while stopping the server', { port, error });
			} else {
				console.log('Server stopped gracefully', { port });
			}
		});

		this.proxies.delete(port);
	}
}
