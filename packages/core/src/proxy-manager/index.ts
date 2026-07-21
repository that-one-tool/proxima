import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Config } from '../configuration';
import { ConnectionPool } from '../connection-pool';
import { LeasedConnection } from '../connection-pool/leased-connection';
import { ContextualError } from '../errors';
import { Logger } from '../logging';
import { ServerBuilder } from '../servers/tcp-tls-server-builder';
import { TransformerFunction } from '../types';

const ALLOW_ALL_IPS = '*.*.*.*';

/** Anything the proxy can write forwarded bytes to: a raw client socket or a leased service connection. */
interface WritableEndpoint {
	write(data: Buffer): boolean;
}

export class ProxyManager extends EventEmitter {
	private config: Config;
	private fromClientTransformer: TransformerFunction;
	private toClientTransformer: TransformerFunction;
	private serviceConnectionPool: ConnectionPool;
	private logger: Logger;

	private readonly proxies: Map<string, net.Server> = new Map();

	constructor(config: Config) {
		super();

		this.config = config;
		this.logger = Logger.getInstance();
		this.serviceConnectionPool = this.initializeServiceConnectionPool();
	}

	private initializeServiceConnectionPool(): ConnectionPool {
		const connectionPool = new ConnectionPool(this.config.forwardServiceOptions, this.config.tlsClientOptions);

		connectionPool.on('ready', () => {
			this.logger.info('[ProxyManager] Service connection pool ready');
		});

		connectionPool.on('error', (error: unknown) => {
			this.logger.error('[ProxyManager] Service connection pool error', { error });
		});

		connectionPool.on('connection', (data: Record<string, unknown>) => {
			this.logger.info('[ProxyManager] New service connection created in pool', data);
		});

		connectionPool.on('connectionClosed', (data: Record<string, unknown>) => {
			this.logger.info('[ProxyManager] Service connection closed in pool', data);
		});

		connectionPool.on('connectionPoolFailure', (data: unknown) => {
			this.logger.error('[ProxyManager] Service connection pool critical failure', { data });
			this.emit('failure');
		});

		return connectionPool;
	}

	setFromClientTransformer(transformFromClient: TransformerFunction): void {
		this.fromClientTransformer = transformFromClient;
	}

	setToClientTransformer(transformToClient: TransformerFunction): void {
		this.toClientTransformer = transformToClient;
	}

	startServers(): void {
		for (const [port, mapping] of Object.entries(this.config.portMapping)) {
			const portNumber = parseInt(port, 10);
			const serverBuilder = new ServerBuilder(this.config.tlsServerOptions);
			const proxy = this.initializeServer(serverBuilder, this.config, portNumber, mapping);
			this.proxies.set(port, proxy);

			proxy.listen(portNumber, () => {
				this.logger.info('[ProxyManager] Reverse proxy listening', { port, mapping });
			});

			proxy.on('close', () => {
				this.logger.info('[ProxyManager] Reverse proxy closed gracefully', { port, mapping });
				this.handleClosedProxy(port);
			});
		}

		this.emit('ready');
	}

	handleClosedProxy(port: string): void {
		this.proxies.delete(port);

		if (this.proxies.size === 0) {
			this.emit('closed');
		}
	}

	async stopServers(): Promise<void> {
		await this.serviceConnectionPool.shutdown().catch((error: unknown) => {
			this.logger.error('[ProxyManager] Error shutting down service connection pool', { error });
		});

		const ports = new Set<string>(this.proxies.keys());

		for (const port of ports) {
			this.logger.info('[ProxyManager] Stopping server', { port });
			this.stopServer(port);
		}
	}

	private initializeServer(serverBuilder: ServerBuilder, config: Config, port: number, mapping: string) {
		return serverBuilder.createServer((clientSocket) => {
			void this.listenConnection(config, clientSocket, port, mapping);
		});
	}

	private isClientAllowedToConnect(config: Config, clientIp: string | undefined): boolean {
		if (!clientIp) {
			return false;
		}

		if (config.ipBlacklist.includes(clientIp)) {
			return false;
		}

		return this.isWhitelisted(config, clientIp);
	}

	private isWhitelisted(config: Config, clientIp: string): boolean {
		return config.ipWhitelist.includes(clientIp) || config.ipWhitelist.includes(ALLOW_ALL_IPS);
	}

	private authorizeClient(config: Config, clientSocket: net.Socket, clientIp: string | undefined, requestId: string): boolean {
		if (this.isClientAllowedToConnect(config, clientIp)) {
			this.logger.debug('[ProxyManager] Client connected', { requestId });
			return true;
		}

		this.logger.warn('[ProxyManager] Client is not allowed to connect. Closing connection...', { requestId });
		clientSocket.end();
		clientSocket.destroy();
		return false;
	}

	private async acquireServiceConnection(clientSocket: net.Socket, requestId: string): Promise<LeasedConnection | null> {
		try {
			const serviceConnexion = await this.serviceConnectionPool.getConnection();
			if (serviceConnexion) {
				return serviceConnexion;
			}

			this.logger.error('[ProxyManager] Failed to acquire a connection from pool', { requestId });
		} catch (error) {
			this.logger.error('[ProxyManager] Failed to establish connection', {
				error: new ContextualError('Connection setup error', { cause: error, context: { requestId } }),
			});
		}

		clientSocket.end();
		return null;
	}

	private async listenConnection(config: Config, clientSocket: net.Socket, port: number, mapping: string): Promise<void> {
		const requestId = randomUUID();
		const clientIp = clientSocket.remoteAddress?.replace('::ffff:', '');

		this.logger.debug('[ProxyManager] Client connection opened', { clientIp, port, mapping, requestId });

		if (!this.authorizeClient(config, clientSocket, clientIp, requestId)) {
			return;
		}

		const serviceConnexion = await this.acquireServiceConnection(clientSocket, requestId);
		if (!serviceConnexion) {
			return;
		}

		this.wireSession(clientSocket, serviceConnexion, mapping, requestId);
	}

	private wireSession(clientSocket: net.Socket, service: LeasedConnection, mapping: string, requestId: string): void {
		const { id: connectionId, leaseId } = service;
		this.logger.debug('[ProxyManager] Using pooled connection to service for client', { requestId, connectionId });

		const onClientData = (data: Buffer) => this.forwardWithTransform(data, this.fromClientTransformer, service, mapping, requestId);
		const onServiceData = (data: Buffer) => this.forwardWithTransform(data, this.toClientTransformer, clientSocket, mapping, requestId);

		let ended = false;
		const endSession = (destroy: boolean): void => {
			if (ended) {
				return;
			}
			ended = true;
			// The pool strips the lease's service-side listeners on release/close — no manual teardown here.
			this.releaseOrClose(connectionId, leaseId, destroy);
		};

		const onServiceClose = () => {
			clientSocket.end();
			endSession(true);
		};

		const onServiceError = (err: Error) => {
			this.logSocketError('Service socket error', err, requestId);
			clientSocket.end();
			endSession(true);
		};

		clientSocket.on('data', onClientData);
		service.on('data', onServiceData);
		clientSocket.on('close', () => endSession(false));
		clientSocket.on('error', (err: Error) => {
			this.logSocketError('Client socket error', err, requestId);
			endSession(false);
		});
		service.on('close', onServiceClose);
		service.on('error', onServiceError);
	}

	private forwardWithTransform(
		data: Buffer,
		transformer: TransformerFunction,
		destination: WritableEndpoint,
		mapping: string,
		requestId: string,
	): void {
		const dataToForward = transformer ? this.applyTransform(transformer, data, mapping, requestId) : data;
		destination.write(dataToForward);
	}

	private applyTransform(
		transformer: NonNullable<TransformerFunction>,
		data: Buffer,
		mapping: string,
		requestId: string,
	): Buffer {
		try {
			return transformer(data, mapping);
		} catch (error) {
			this.logger.error('[ProxyManager] Error transforming data', {
				error: new ContextualError('Transform error', { cause: error, context: { requestId } }),
			});
			return data;
		}
	}

	private releaseOrClose(connectionId: string, leaseId: number, destroy: boolean): void {
		if (destroy) {
			this.serviceConnectionPool.closeConnection(connectionId);
			return;
		}

		this.serviceConnectionPool.releaseConnection(connectionId, leaseId);
	}

	private logSocketError(message: string, error: Error, requestId: string): void {
		this.logger.error(`[ProxyManager] ${message}`, {
			error: new ContextualError(message, { cause: error, context: { requestId } }),
		});
	}

	private stopServer(port: string): void {
		const proxy = this.proxies.get(port);

		proxy?.close((error) => {
			if (error) {
				this.logger.error('[ProxyManager] An error occured while stopping the server', { port, error });
			}
		});
	}
}
