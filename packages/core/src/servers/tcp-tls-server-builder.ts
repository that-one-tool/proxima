import * as net from 'node:net';
import * as tls from 'node:tls';
import { ContextualError } from '../errors';
import { TlsServerClientOptions } from '../types';
import { makeTlsOptions, validateOptions } from '../utils/tls';

/**
 * Server class that encapsulates either a TCP or TLS server based on options
 */
export class ServerBuilder {
	private server: net.Server | tls.Server | undefined = undefined;
	private options: TlsServerClientOptions;

	/**
	 * Create a new server instance
	 * @param options Server options
	 */
	constructor(options: TlsServerClientOptions) {
		validateOptions(options);
		this.options = options;
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
		if (this.options.useTls) {
			return this.createTlsServer(listener);
		} else {
			return this.createTcpServer(listener);
		}
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

			return tls.createServer(
				{
					cert: tlsOptions.cert,
					key: tlsOptions.key,
					ca: tlsOptions.ca,
					requestCert: this.options.tlsOptions.requestCert,
					rejectUnauthorized: this.options.tlsOptions.rejectUnauthorized,
				},
				listener,
			);
		} catch (error) {
			throw new ContextualError('Failed to create TLS server', { cause: error });
		}
	}
}
