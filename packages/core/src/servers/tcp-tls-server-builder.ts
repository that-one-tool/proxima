import * as net from 'node:net';
import * as tls from 'node:tls';
import { ContextualError } from '../errors';
import { Logger } from '../logging';
import { TlsServerClientOptions } from '../types';
import { makeTlsOptions, validateTlsOptions } from '../utils/tls';

/**
 * Server class that encapsulates either a TCP or TLS server based on options
 */
export class ServerBuilder {
	private server: net.Server | tls.Server | undefined = undefined;
	private options: TlsServerClientOptions;
	private logger: Logger;

	/**
	 * Create a new server instance
	 * @param options Server options
	 */
	constructor(options: TlsServerClientOptions) {
		validateTlsOptions(options);
		this.options = options;
		this.logger = Logger.getInstance();
	}

	/**
	 * Get the underlying server instance
	 */
	getServer(): net.Server | tls.Server | undefined {
		return this.server;
	}

	/**
	 * Create a server instance based on the options
	 */
	createServer(listener: (socket: net.Socket) => void): net.Server | tls.Server {
		const server = this.buildServer(listener);
		this.attachErrorListener(server);
		this.server = server;

		return server;
	}

	private buildServer(listener: (socket: net.Socket) => void): net.Server | tls.Server {
		if (this.options.useTls) {
			return this.createTlsServer(listener);
		}

		return this.createTcpServer(listener);
	}

	private attachErrorListener(server: net.Server | tls.Server): void {
		server.on('error', (error) => {
			this.logger.error('[ServerBuilder] Server error', { error });
		});
	}

	/**
	 * Create a TCP server
	 */
	private createTcpServer(listener: (socket: net.Socket) => void): net.Server {
		return net.createServer(listener);
	}

	/**
	 * Create a TLS server
	 */
	private createTlsServer(listener: (socket: net.Socket) => void): tls.Server {
		if (!this.options.tlsOptions) {
			throw new ContextualError('TLS options must be provided for TLS server type');
		}

		try {
			const tlsOptions = makeTlsOptions(this.options.tlsOptions);

			const server = tls.createServer(
				{
					cert: tlsOptions.cert,
					key: tlsOptions.key,
					ca: tlsOptions.ca,
					requestCert: this.options.tlsOptions.requestCert,
					rejectUnauthorized: this.options.tlsOptions.rejectUnauthorized,
					minVersion: 'TLSv1.2',
				},
				listener,
			);

			server.on('tlsClientError', (error) => {
				this.logger.error('[ServerBuilder] TLS client handshake error', { error });
			});

			return server;
		} catch (error) {
			throw new ContextualError('Failed to create TLS server', { cause: error });
		}
	}
}
