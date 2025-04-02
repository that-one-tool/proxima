import { Config, getConfig } from '../configuration';
import { ProxyManager } from '../proxy-manager';
import { HttpServer } from '../servers/http-server';
import { TransformerFunction } from '../types';

export class Proxima {
	private config: Config;
	private proxyManager: ProxyManager;
	private httpServer: HttpServer;

	constructor() {
		this.config = getConfig();
		this.proxyManager = new ProxyManager(this.config);
		this.httpServer = new HttpServer(this.config.trustedHttpPort, this.config.version);
	}

	addTransformers(fromClientTransformer: TransformerFunction, toClientTransformer: TransformerFunction): Proxima {
		this.proxyManager.setFromClientTransformer(fromClientTransformer);
		this.proxyManager.setToClientTransformer(toClientTransformer);

		return this;
	}

	start(): Proxima {
		try {
			console.log('Starting Proxima...');

			this.proxyManager.startServers();

			console.log(
				`Forwarding to ${this.config.forwardServiceOptions.name} at ${this.config.forwardServiceOptions.host}:${this.config.forwardServiceOptions.port}`,
			);

			this.httpServer.start();

			console.log(`HTTP server listening on port ${this.config.trustedHttpPort} for healthcheck and metrics`);
		} catch (error) {
			console.error(error);
			this.handleShutdown(1);
		}

		return this;
	}

	async stop(): Promise<void> {
		await this.handleShutdown(0);
	}

	private async handleShutdown(exitCode: number): Promise<void> {
		await this.proxyManager.stopServers();
		this.httpServer.stop();
		process.exit(exitCode);
	}
}
