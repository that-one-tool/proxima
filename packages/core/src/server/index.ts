import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { ContextualError } from '../errors';
import { TlsServerClientOptions } from './types';

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
		this.validateOptions(options);
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
		const tlsOptions = this.options.tlsOptions;

		if (!tlsOptions) {
			throw new ContextualError('TLS options must be provided for TLS server type');
		}

		try {
			if (!fs.existsSync(tlsOptions.certPath)) {
				throw new ContextualError('Certificate file not found', { context: { path: tlsOptions.certPath } });
			}

			if (!fs.existsSync(tlsOptions.keyPath)) {
				throw new ContextualError('Private key file not found', { context: { path: tlsOptions.keyPath } });
			}

			const cert = fs.readFileSync(tlsOptions.certPath);
			const key = fs.readFileSync(tlsOptions.keyPath);

			let ca: Buffer | undefined;
			if (tlsOptions.caPath && fs.existsSync(tlsOptions.caPath)) {
				ca = fs.readFileSync(tlsOptions.caPath);
			}

			return tls.createServer(
				{
					cert,
					key,
					ca: ca ? [ca] : undefined,
					requestCert: tlsOptions.requestCert,
					rejectUnauthorized: tlsOptions.rejectUnauthorized,
				},
				listener,
			);
		} catch (error) {
			throw new ContextualError('Failed to create TLS server', { cause: error });
		}
	}

	/**
	 * Validate the server options
	 */
	private validateOptions(options: TlsServerClientOptions): void {
		if (options.useTls) {
			const hasCertPath = this.options.tlsOptions?.certPath;
			const hasKeyPath = this.options.tlsOptions?.keyPath;

			if (!hasCertPath || !hasKeyPath) {
				throw new ContextualError(
					'TLS_SERVER_CERT_PATH and TLS_SERVER_KEY_PATH environment variables must be set to use a TLS server',
				);
			}
		}
	}
}
