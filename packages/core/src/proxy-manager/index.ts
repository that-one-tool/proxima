import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Config } from '../configuration';
import { ConnectionPool } from '../connection-pool';
import { ContextualError } from '../errors';
import { TransformFunction } from '../types';

export class ProxyManager {
	private config: Config;
	private transformFromClient: TransformFunction;
	private transformToClient: TransformFunction;
	private serviceConnectionPool: ConnectionPool;

	private readonly proxies: Map<string, net.Server> = new Map();

	constructor(config: Config) {
		this.config = config;
		this.serviceConnectionPool = this.initializeServiceConnectionPool();
	}

	private initializeServiceConnectionPool(): ConnectionPool {
		const connectionPool = new ConnectionPool(this.config.forwardServiceOptions);

		connectionPool.on('ready', () => {
			console.log('Service connection pool ready');
		});

		connectionPool.on('error', (error) => {
			console.error('Service connection pool error', error);
		});

		connectionPool.on('connection', (data) => {
			console.log('New service connection created in pool', data);
		});

		connectionPool.on('connectionClosed', (data) => {
			console.log('Service connection closed in pool', data);
		});

		connectionPool.on('connectionPoolFailure', async (data) => {
			console.error('Service connection pool critical failure. Exiting...', data);
			await this.stopServers();
		});

		return connectionPool;
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
			this.proxies.set(port, proxy);

			proxy.listen(port, () => {
				console.log('=> Reverse proxy listening', { port, mapping });
			});

			proxy.on('close', () => {
				console.log('=> Reverse proxy closed gracefully', { port, mapping });
				this.handleClosedProxy(port);
			});
		}
	}

	async handleClosedProxy(port: string): Promise<void> {
		this.proxies.delete(port);

		if (this.proxies.size === 0) {
			console.log('=> No reverse proxies left. Exiting...');
			process.exit(0);
		}
	}

	async stopServers(): Promise<void> {
		await this.serviceConnectionPool.shutdown().catch((error) => {
			console.error('Error shutting down service connection pool', error);
		});

		const ports = new Set<string>(this.proxies.keys());

		for (const port of ports) {
			this.stopServer(port);
		}
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
			console.warn('Client is not allowed to connect. Closing connection...', { requestId });
			clientSocket.end();
			clientSocket.destroy();
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
					try {
						dataToForward = this.transformFromClient(data, mapping);
						console.log('Data from client transformed', { requestId });
					} catch (error) {
						console.error(
							'Error transforming data from client',
							new ContextualError('Transform error', { cause: error, context: { requestId } }),
						);
					}
				}

				serviceSocket.write(dataToForward);
				console.log('Data sent to service for client', { requestId });
			});

			serviceSocket.on('data', (data: Buffer) => {
				console.log('Received data from service for client', { requestId });
				let dataToForward = data;

				if (this.transformToClient) {
					try {
						dataToForward = this.transformToClient(data, mapping);
						console.log('Data from service transformed', { requestId });
					} catch (error) {
						console.error(
							'Error transforming data from service',
							new ContextualError('Transform error', { cause: error, context: { requestId } }),
						);
					}
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
			}
		});

		this.proxies.delete(port);
	}
}
