/// <reference types="jest" />
import { EventEmitter } from 'node:events';

jest.mock('../../src/logging', () => ({
	Logger: {
		getInstance: jest.fn(() => ({
			info: jest.fn(),
			debug: jest.fn(),
			error: jest.fn(),
			warn: jest.fn(),
		})),
	},
}));

import { HttpServer } from '../../src/servers/http-server';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeRequest(method: string, url: string): any {
	const req: any = new EventEmitter();
	req.method = method;
	req.url = url;
	return req;
}

function makeResponse(): any {
	const res: any = new EventEmitter();
	res.statusCode = 200;
	res.writeHead = jest.fn();
	res.end = jest.fn();
	return res;
}

function internalServer(httpServer: HttpServer): any {
	return (httpServer as unknown as { server: EventEmitter }).server;
}

describe('HttpServer', () => {
	it('surfaces server errors as an emitted event instead of crashing', () => {
		const httpServer = new HttpServer(0, 'v');
		const errors: Error[] = [];
		httpServer.on('error', (error: Error) => errors.push(error));

		internalServer(httpServer).emit('error', new Error('EADDRINUSE'));

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('EADDRINUSE');
	});

	it('emits ready once the underlying server listens', () => {
		const httpServer = new HttpServer(0, 'v');
		const server = internalServer(httpServer);
		server.listen = jest.fn((port: number, cb: () => void) => cb());
		const ready = jest.fn();
		httpServer.on('ready', ready);

		httpServer.start();

		expect(ready).toHaveBeenCalledTimes(1);
	});

	it('answers the healthcheck with a 200 status payload', () => {
		const httpServer = new HttpServer(0, 'v1.2.3');
		const req = makeRequest('GET', '/api/v1/healthcheck');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);

		expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
		const body = JSON.parse(res.end.mock.calls[0][0]);
		expect(body.status).toBe('ok');
		expect(body.version).toBe('v1.2.3');
	});

	it('serves metrics on success', async () => {
		const httpServer = new HttpServer(0, 'v');
		(httpServer as any).register.metrics = jest.fn().mockResolvedValue('metric_data 1');
		const req = makeRequest('GET', '/api/v1/metrics');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);
		await flush();

		expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': expect.stringContaining('text/plain') }));
		expect(res.end).toHaveBeenCalledWith('metric_data 1');
	});

	it('responds 500 when the metrics collection rejects instead of hanging', async () => {
		const httpServer = new HttpServer(0, 'v');
		(httpServer as any).register.metrics = jest.fn().mockRejectedValue(new Error('collect failed'));
		const req = makeRequest('GET', '/api/v1/metrics');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);
		await flush();

		expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
		expect(res.end).toHaveBeenCalledTimes(1);
	});

	it('returns 404 for unknown routes', () => {
		const httpServer = new HttpServer(0, 'v');
		const req = makeRequest('GET', '/nope');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);

		expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
	});

	it('returns 405 for non-GET methods', () => {
		const httpServer = new HttpServer(0, 'v');
		const req = makeRequest('POST', '/api/v1/healthcheck');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);

		expect(res.writeHead).toHaveBeenCalledWith(405, { 'Content-Type': 'application/json' });
	});

	it('observes request duration on response finish', () => {
		const httpServer = new HttpServer(0, 'v');
		const endTimer = jest.fn();
		(httpServer as any).durationHistogram.startTimer = jest.fn(() => endTimer);
		const req = makeRequest('GET', '/api/v1/healthcheck');
		const res = makeResponse();

		internalServer(httpServer).emit('request', req, res);
		res.emit('finish');

		expect(endTimer).toHaveBeenCalledTimes(1);
	});

	it('resolves stop() and is idempotent', async () => {
		const httpServer = new HttpServer(0, 'v');
		const server = internalServer(httpServer);
		server.close = jest.fn((cb: (err?: Error) => void) => cb());

		const first = httpServer.stop();
		const second = httpServer.stop();

		expect(first).toBe(second);
		await expect(first).resolves.toBeUndefined();
		expect(server.close).toHaveBeenCalledTimes(1);
	});

	it('rejects stop() when close reports an error', async () => {
		const httpServer = new HttpServer(0, 'v');
		const server = internalServer(httpServer);
		server.close = jest.fn((cb: (err?: Error) => void) => cb(new Error('close failed')));

		await expect(httpServer.stop()).rejects.toThrow('close failed');
	});
});
