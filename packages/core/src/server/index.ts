import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { Config } from '../configuration';
import { ContextualError } from '../errors';
import { ServerOptions, ServerType } from './types';

/**
 * Server class that encapsulates either a TCP or TLS server
 * based on configuration or environment variables
 */
export class Server {
	private server: net.Server | tls.Server;
	private config: Config;
	private options: ServerOptions;
	private port: number;

	/**
	 * Create a new server instance
	 * @param config Application configuration
	 * @param port Port to listen on
	 * @param options Optional server options (if not provided, will use environment variables)
	 */
	constructor(config: Config, port: number, options?: ServerOptions) {
		this.config = config;
		this.port = port;
		this.options = options || this.getServerOptionsFromEnv();
		this.server = this.createServer();
	}

	/**
	 * Get the underlying server instance
	 */
	getServer(): net.Server | tls.Server {
		return this.server;
	}

	/**
	 * Start the server on the configured port
	 * @param callback Optional callback function to execute when the server starts listening
	 */
	listen(callback?: () => void): void {
		this.server.listen(this.port, () => {
			console.log(`Server listening on port ${this.port} (${this.options.type})`);
			if (callback) {
				callback();
			}
		});
	}

	/**
	 * Stop the server
	 * @param callback Optional callback to execute when the server closes
	 */
	close(callback?: (error?: Error) => void): void {
		this.server.close(callback);
	}

	/**
	 * Set a connection listener for the server
	 * @param listener The connection listener function
	 */
	onConnection(listener: (socket: net.Socket) => void): void {
		// Remove any existing listeners
		this.server.removeAllListeners('connection');

		// Add the new listener
		this.server.on('connection', listener);
	}

	/**
	 * Create a server instance based on the options
	 */
	private createServer(): net.Server | tls.Server {
		if (this.options.type === ServerType.TLS) {
			return this.createTlsServer();
		} else {
			return this.createTcpServer();
		}
	}

	/**
	 * Create a TCP server
	 */
	private createTcpServer(): net.Server {
		return net.createServer();
	}

	/**
	 * Create a TLS server
	 */
	private createTlsServer(): tls.Server {
		const tlsOptions = this.options.tlsOptions;

		if (!tlsOptions) {
			throw new ContextualError('TLS options must be provided for TLS server type');
		}

		try {
			// Validate TLS certificate files exist
			if (!fs.existsSync(tlsOptions.certPath)) {
				throw new ContextualError('Certificate file not found', { context: { path: tlsOptions.certPath } });
			}

			if (!fs.existsSync(tlsOptions.keyPath)) {
				throw new ContextualError('Private key file not found', { context: { path: tlsOptions.keyPath } });
			}

			// Load certificate files
			const cert = fs.readFileSync(tlsOptions.certPath);
			const key = fs.readFileSync(tlsOptions.keyPath);

			// Load CA cert if provided
			let ca: Buffer | undefined;
			if (tlsOptions.caPath && fs.existsSync(tlsOptions.caPath)) {
				ca = fs.readFileSync(tlsOptions.caPath);
			}

			// Create TLS server
			return tls.createServer({
				cert,
				key,
				ca: ca ? [ca] : undefined,
				requestCert: tlsOptions.requestCert,
				rejectUnauthorized: tlsOptions.rejectUnauthorized,
			});
		} catch (error) {
			throw new ContextualError('Failed to create TLS server', { cause: error });
		}
	}

	/**
	 * Get server options from environment variables
	 * @returns Server options configured from environment variables
	 */
	private getServerOptionsFromEnv(): ServerOptions {
		const serverType = process.env.SERVER_TYPE?.toLowerCase() === 'tls' ? ServerType.TLS : ServerType.TCP;

		const options: ServerOptions = {
			type: serverType,
		};

		if (serverType === ServerType.TLS) {
			const certPath = process.env.TLS_CERT_PATH;
			const keyPath = process.env.TLS_KEY_PATH;

			if (!certPath || !keyPath) {
				throw new ContextualError('TLS_CERT_PATH and TLS_KEY_PATH environment variables must be set for TLS server');
			}

			options.tlsOptions = {
				certPath,
				keyPath,
				caPath: process.env.TLS_CA_PATH,
				requestCert: process.env.TLS_REQUEST_CERT === 'true',
				rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED === 'true',
			};
		}

		return options;
	}
}
