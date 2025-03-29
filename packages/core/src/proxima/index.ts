import { Config, getConfig } from '../configuration';
import { ProxyManager } from '../proxy-manager';
import { TransformFunction } from '../types';

export class Proxima {
	private config: Config;
	private proxyManager: ProxyManager;

	constructor() {
		this.config = getConfig();
		this.proxyManager = new ProxyManager(this.config);
	}

	addTransformers(transformFromClient: TransformFunction, transformToClient: TransformFunction): Proxima {
		this.proxyManager.setTransformFromClient(transformFromClient);
		this.proxyManager.setTransformToClient(transformToClient);

		return this;
	}

	start(): Proxima {
		try {
			console.log('Starting Proxima...');

			this.proxyManager.startServers();

			console.log(`Forwarding to ${this.config.forwardServiceName} at ${this.config.forwardHost}:${this.config.forwardPort}`);

			return this;
		} catch (error) {
			console.error(error);
			this.proxyManager.stopServers();
			process.exit(1);
		}
	}

	stop(): void {
		this.proxyManager.stopServers();
	}
}
