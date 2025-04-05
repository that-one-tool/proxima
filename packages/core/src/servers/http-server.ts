import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import * as client from 'prom-client';
import { Logger } from '../logging';

enum MetricLabel {
	PATH = 'path',
	METHOD = 'method',
	STATUS_CODE = 'status_code',
}

export class HttpServer extends EventEmitter {
	private readonly server: Server;
	private readonly port: number;
	private readonly register: client.Registry;
	private readonly version: string;
	private logger: Logger;

	constructor(port: number, version: string) {
		super();

		this.port = port;
		this.version = version;
		this.logger = Logger.getInstance();
		this.register = this.makeInitializedRegister();

		this.server = new Server();

		this.setupRoutes();
	}

	public start(): void {
		this.server.listen(this.port, () => {
			this.logger.info(`[HttpServer] Server listening on port ${this.port} for healthcheck and metrics`);
			this.emit('ready');
		});
	}

	public stop(): void {
		this.server.close(() => {
			this.logger.info('[HttpServer] Server stopped');
			this.emit('closed');
		});
	}

	private handleHealthCheck(req: any, res: any): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', timestamp: Date.now(), uptime: process.uptime(), version: this.version }));
	}

	private async handleMetrics(req: any, res: any): Promise<void> {
		res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
		const metrics = await this.register.metrics();
		res.end(metrics);
	}

	private handleNotFound(req: any, res: any): void {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not Found' }));
	}

	private handleMethodNotAllowed(req: any, res: any): void {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Method Not Allowed' }));
	}

	private makeInitializedRegister() {
		const register = new client.Registry();

		register.setDefaultLabels({ app: 'backend' });
		client.collectDefaultMetrics({ register });

		const http_response_rate_histogram = new client.Histogram({
			name: 'node_http_duration',
			labelNames: [MetricLabel.PATH, MetricLabel.METHOD, MetricLabel.STATUS_CODE],
			help: 'The duration of HTTP requests in seconds',
			buckets: [
				0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.5, 3.0,
				3.5, 4.0, 4.5, 5.0, 10,
			],
		});
		register.registerMetric(http_response_rate_histogram);

		return register;
	}

	private setupRoutes(): void {
		this.server.on('request', (req, res) => {
			const url = req.url;

			if (req.method !== 'GET') {
				this.handleMethodNotAllowed(req, res);
				return;
			}

			switch (url) {
				case '/api/v1/healthcheck':
					this.handleHealthCheck(req, res);
					break;
				case '/api/v1/metrics':
					void this.handleMetrics(req, res);
					break;
				default:
					this.handleNotFound(req, res);
			}
		});
	}
}
