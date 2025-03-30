import { Config, getConfig } from '../configuration';
import { ProxyManager } from '../proxy-manager';
import { TransformerFunction } from '../types';

export class Proxima {
	private config: Config;
	private proxyManager: ProxyManager;

	constructor() {
		this.config = getConfig();
		this.proxyManager = new ProxyManager(this.config);
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

			return this;
		} catch (error) {
			console.error(error);
			this.proxyManager.stopServers();
			process.exit(1);
		}
	}

	async stop(): Promise<void> {
		await this.proxyManager.stopServers();
		process.exit(0);
	}
}
