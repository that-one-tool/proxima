import { Config, getConfig } from '../configuration';
import { Logger } from '../logging';
import { LoggerOptions } from '../logging/types';
import { ProxyManager } from '../proxy-manager';
import { HttpServer } from '../servers/http-server';
import { TransformerFunction } from '../types';

export class Proxima {
	private config: Config;
	private proxyManager: ProxyManager;
	private httpServer: HttpServer;
	private logger: Logger;

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

			this.proxyManager.on('ready', () => {
				this.logger.info(
					`[Proxima] Forwarding to ${this.config.forwardServiceOptions.name} ` +
						`at ${this.config.forwardServiceOptions.host}:${this.config.forwardServiceOptions.port}`,
				);
			});

			this.proxyManager.on('closed', () => {
				this.logger.info('[Proxima] No reverse proxies left. Exiting...');
				this.httpServer.on('closed', () => {
					process.exit(0);
				});
				this.httpServer.stop();
			});

			this.proxyManager.on('failure', () => {
				this.logger.info('[Proxima] Service connection pool critical failure. Exiting...');
				this.handleShutdown(1);
			});

			this.httpServer.start();
			this.proxyManager.startServers();
		} catch (error) {
			this.logger.error('[Proxima] An unexpected exception occured', { error });
			this.handleShutdown(1);
		}

		return this;
	}

	async stop(): Promise<void> {
		await this.handleShutdown(0);
	}

	private async handleShutdown(exitCode: number): Promise<void> {
		await this.proxyManager.stopServers();
		this.httpServer.on('closed', () => {
			process.exit(exitCode);
		});
		this.httpServer.stop();
	}
}
