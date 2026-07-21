/// <reference types="jest" />
const proxyManagerInstances: any[] = [];
const httpServerInstances: any[] = [];

jest.mock('../../src/configuration', () => ({
	getConfig: jest.fn(() => ({
		trustedHttpPort: 9101,
		version: '0.0.0-test',
		forwardServiceOptions: { name: 'redis', host: 'localhost', port: 6379 },
	})),
}));

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

jest.mock('../../src/proxy-manager', () => {
	const { EventEmitter: Emitter } = require('node:events');
	return {
		ProxyManager: jest.fn().mockImplementation(() => {
			const emitter: any = new Emitter();
			emitter.setFromClientTransformer = jest.fn();
			emitter.setToClientTransformer = jest.fn();
			emitter.startServers = jest.fn();
			emitter.stopServers = jest.fn().mockResolvedValue(undefined);
			proxyManagerInstances.push(emitter);
			return emitter;
		}),
	};
});

jest.mock('../../src/servers/http-server', () => {
	const { EventEmitter: Emitter } = require('node:events');
	return {
		HttpServer: jest.fn().mockImplementation(() => {
			const emitter: any = new Emitter();
			emitter.start = jest.fn();
			emitter.stop = jest.fn().mockResolvedValue(undefined);
			httpServerInstances.push(emitter);
			return emitter;
		}),
	};
});

import { Proxima } from '../../src/proxima';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Proxima', () => {
	let exitSpy: jest.SpyInstance;

	beforeEach(() => {
		proxyManagerInstances.length = 0;
		httpServerInstances.length = 0;
		exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	it('forwards transformers to the proxy manager', () => {
		const proxima = new Proxima();
		const fromClient = jest.fn();
		const toClient = jest.fn();

		proxima.addTransformers(fromClient, toClient);

		const proxyManager = proxyManagerInstances[0];
		expect(proxyManager.setFromClientTransformer).toHaveBeenCalledWith(fromClient);
		expect(proxyManager.setToClientTransformer).toHaveBeenCalledWith(toClient);
	});

	it('exits 1 on failure even when a later closed event would exit 0', async () => {
		const proxima = new Proxima();
		proxima.start();

		const proxyManager = proxyManagerInstances[0];
		proxyManager.stopServers = jest.fn().mockImplementation(() => {
			proxyManager.emit('closed');
			return Promise.resolve();
		});

		proxyManager.emit('failure');
		await flush();

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(exitSpy).not.toHaveBeenCalledWith(0);
		expect(exitSpy).toHaveBeenCalledTimes(1);
	});

	it('does not accumulate httpServer closed listeners across repeated shutdowns', async () => {
		const proxima = new Proxima();
		proxima.start();

		const proxyManager = proxyManagerInstances[0];
		const httpServer = httpServerInstances[0];

		proxyManager.emit('closed');
		proxyManager.emit('failure');
		await flush();

		expect(httpServer.listenerCount('closed')).toBe(0);
		expect(exitSpy).toHaveBeenCalledTimes(1);
	});

	it('stops both subsystems and exits 0 on stop()', async () => {
		const proxima = new Proxima();
		proxima.start();

		await proxima.stop();

		const proxyManager = proxyManagerInstances[0];
		const httpServer = httpServerInstances[0];
		expect(proxyManager.stopServers).toHaveBeenCalledTimes(1);
		expect(httpServer.stop).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it('routes an HTTP server error to a failure exit', async () => {
		const proxima = new Proxima();
		proxima.start();

		const httpServer = httpServerInstances[0];
		httpServer.emit('error', new Error('listen failed'));
		await flush();

		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('exits 1 when startup throws synchronously', async () => {
		const proxima = new Proxima();
		const proxyManager = proxyManagerInstances[0];
		proxyManager.startServers = jest.fn(() => {
			throw new Error('boom');
		});

		proxima.start();
		await flush();

		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
