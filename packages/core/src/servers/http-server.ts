import { EventEmitter } from 'node:events';
import { IncomingMessage, Server, ServerResponse } from 'node:http';
import * as client from 'prom-client';
import { Logger } from '../logging';

enum MetricLabel {
	PATH = 'path',
	METHOD = 'method',
	STATUS_CODE = 'status_code',
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
type DurationTimer = (labels?: Partial<Record<MetricLabel, string | number>>) => number;

export class HttpServer extends EventEmitter {
	private readonly server: Server;
	private readonly port: number;
	private readonly register: client.Registry;
	private readonly durationHistogram: client.Histogram<MetricLabel>;
	private readonly routes: Map<string, RouteHandler>;
	private readonly version: string;
	private logger: Logger;
	private stopPromise: Promise<void> | undefined;

	constructor(port: number, version: string) {
		super();

		this.port = port;
		this.version = version;
		this.logger = Logger.getInstance();
		this.durationHistogram = HttpServer.makeDurationHistogram();
		this.register = this.makeInitializedRegister();
		this.routes = new Map<string, RouteHandler>([
			['/api/v1/healthcheck', (req, res) => this.handleHealthCheck(req, res)],
			['/api/v1/metrics', (req, res) => void this.handleMetrics(req, res)],
		]);

		this.server = new Server();
		this.server.on('error', (error) => this.handleServerError(error));

		this.setupRoutes();
	}

	public start(): void {
		this.server.listen(this.port, () => {
			this.logger.info(`[HttpServer] Server listening on port ${this.port} for healthcheck and metrics`);
			this.emit('ready');
		});
	}

	public stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}

		this.stopPromise = new Promise<void>((resolve, reject) => {
			this.server.close((error) => this.handleServerClosed(error, resolve, reject));
		});

		return this.stopPromise;
	}

	private handleServerError(error: Error): void {
		this.logger.error('[HttpServer] Server error', { error });
		this.emit('error', error);
	}

	private handleServerClosed(error: Error | undefined, resolve: () => void, reject: (error: Error) => void): void {
		if (error) {
			this.logger.error('[HttpServer] Error stopping server', { error });
			this.emit('closed');
			reject(error);
			return;
		}

		this.logger.info('[HttpServer] Server stopped');
		this.emit('closed');
		resolve();
	}

	private handleHealthCheck(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', timestamp: Date.now(), uptime: process.uptime(), version: this.version }));
	}

	private async handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const metrics = await this.register.metrics();
			res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
			res.end(metrics);
		} catch (error) {
			this.logger.error('[HttpServer] Failed to collect metrics', { error });
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal Server Error' }));
		}
	}

	private handleNotFound(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not Found' }));
	}

	private handleMethodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Method Not Allowed' }));
	}

	private static makeDurationHistogram(): client.Histogram<MetricLabel> {
		return new client.Histogram({
			name: 'node_http_duration',
			labelNames: [MetricLabel.PATH, MetricLabel.METHOD, MetricLabel.STATUS_CODE],
			help: 'The duration of HTTP requests in seconds',
			registers: [],
			buckets: [
				0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.5, 3.0,
				3.5, 4.0, 4.5, 5.0, 10,
			],
		});
	}

	private makeInitializedRegister(): client.Registry {
		const register = new client.Registry();

		register.setDefaultLabels({ app: 'backend' });
		client.collectDefaultMetrics({ register });
		register.registerMetric(this.durationHistogram);

		return register;
	}

	private setupRoutes(): void {
		this.server.on('request', (req, res) => this.handleRequest(req, res));
	}

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		const endTimer = this.durationHistogram.startTimer();
		res.on('finish', () => this.observeDuration(endTimer, req, res));
		this.routeRequest(req, res);
	}

	private routeRequest(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== 'GET') {
			this.handleMethodNotAllowed(req, res);
			return;
		}

		const handler = this.routes.get(req.url ?? '');
		if (!handler) {
			this.handleNotFound(req, res);
			return;
		}

		handler(req, res);
	}

	private observeDuration(endTimer: DurationTimer, req: IncomingMessage, res: ServerResponse): void {
		endTimer({
			[MetricLabel.PATH]: req.url ?? '',
			[MetricLabel.METHOD]: req.method ?? '',
			[MetricLabel.STATUS_CODE]: res.statusCode,
		});
	}
}
