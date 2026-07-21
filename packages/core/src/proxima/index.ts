import { Config, getConfig } from '../configuration';
import { Logger } from '../logging';
import { LoggerOptions } from '../logging/types';
import { ProxyManager } from '../proxy-manager';
import { HttpServer } from '../servers/http-server';
import { TransformerFunction } from '../types';

const SHUTDOWN_TIMEOUT_MS = 10000;

export class Proxima {
	private config: Config;
	private proxyManager: ProxyManager;
	private httpServer: HttpServer;
	private logger: Logger;
	private isShuttingDown = false;

	constructor(options?: LoggerOptions) {
		this.logger = Logger.getInstance(options);

		this.config = getConfig();
		this.logger.debug('[Proxima] Config loaded', { config: this.config });

		this.proxyManager = new ProxyManager(this.config);
		this.httpServer = new HttpServer(this.config.trustedHttpPort, this.config.version);
		this.logger.info('[Proxima] Proxima initialized');
	}

	addTransformers(fromClientTransformer: TransformerFunction, toClientTransformer: TransformerFunction): Proxima {
		this.proxyManager.setFromClientTransformer(fromClientTransformer);
		this.proxyManager.setToClientTransformer(toClientTransformer);

		return this;
	}

	start(): Proxima {
		try {
			this.logger.info('[Proxima] Starting Proxima servers...');
			this.registerLifecycleHandlers();

			this.httpServer.start();
			this.proxyManager.startServers();
		} catch (error) {
			this.logger.error('[Proxima] An unexpected exception occured', { error });
			void this.shutdownAndExit(1);
		}

		return this;
	}

	async stop(): Promise<void> {
		await this.shutdownAndExit(0);
	}

	private registerLifecycleHandlers(): void {
		this.proxyManager.on('ready', () => {
			this.logger.info(
				`[Proxima] Forwarding to ${this.config.forwardServiceOptions.name} ` +
					`at ${this.config.forwardServiceOptions.host}:${this.config.forwardServiceOptions.port}`,
			);
		});

		this.proxyManager.on('closed', () => {
			this.logger.info('[Proxima] No reverse proxies left. Exiting...');
			void this.shutdownAndExit(0);
		});

		this.proxyManager.on('failure', () => {
			this.logger.info('[Proxima] Service connection pool critical failure. Exiting...');
			void this.shutdownAndExit(1);
		});

		this.httpServer.on('error', (error) => {
			this.logger.error('[Proxima] HTTP server error', { error });
			void this.shutdownAndExit(1);
		});
	}

	private async shutdownAndExit(exitCode: number): Promise<void> {
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;

		await Promise.race([this.stopServers(), this.shutdownTimeout()]);
		process.exit(exitCode);
	}

	private async stopServers(): Promise<void> {
		await this.proxyManager.stopServers();
		await this.httpServer.stop().catch((error) => {
			this.logger.error('[Proxima] Error stopping HTTP server', { error });
		});
	}

	private shutdownTimeout(): Promise<void> {
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				this.logger.error('[Proxima] Shutdown timed out, forcing exit');
				resolve();
			}, SHUTDOWN_TIMEOUT_MS).unref();
		});
	}
}
