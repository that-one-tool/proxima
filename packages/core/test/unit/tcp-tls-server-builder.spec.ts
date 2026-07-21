/// <reference types="jest" />
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';

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

jest.mock('node:tls', () => {
	const actual = jest.requireActual('node:tls');
	return { ...actual, createServer: jest.fn() };
});

jest.mock('../../src/utils/tls', () => {
	const actual = jest.requireActual('../../src/utils/tls');
	return {
		...actual,
		makeTlsOptions: jest.fn(() => ({ cert: Buffer.from('cert'), key: Buffer.from('key'), ca: [Buffer.from('ca')] })),
	};
});

import { ServerBuilder } from '../../src/servers/tcp-tls-server-builder';

const noopListener = () => undefined;

describe('ServerBuilder', () => {
	afterEach(() => {
		jest.clearAllMocks();
	});

	it('throws at construction when TLS is enabled without cert/key', () => {
		expect(() => new ServerBuilder({ useTls: true, tlsOptions: { certPath: '', keyPath: '' } })).toThrow();
	});

	it('builds a TCP server and exposes it via getServer', () => {
		const builder = new ServerBuilder({ useTls: false });

		const server = builder.createServer(noopListener);

		expect(server).toBeInstanceOf(net.Server);
		expect(builder.getServer()).toBe(server);
		server.close();
	});

	it('attaches an error listener so a bind failure does not crash', () => {
		const builder = new ServerBuilder({ useTls: false });
		const server = builder.createServer(noopListener);

		expect(server.listenerCount('error')).toBeGreaterThanOrEqual(1);
		expect(() => server.emit('error', new Error('EADDRINUSE'))).not.toThrow();
		server.close();
	});

	it('creates a TLS server with an explicit minVersion and mTLS options', () => {
		const fakeServer: any = new EventEmitter();
		(tls.createServer as jest.Mock).mockReturnValue(fakeServer);

		const builder = new ServerBuilder({
			useTls: true,
			tlsOptions: { certPath: '/c', keyPath: '/k', caPath: '/ca', requestCert: true, rejectUnauthorized: true },
		});

		const server = builder.createServer(noopListener);

		const passedOptions = (tls.createServer as jest.Mock).mock.calls[0][0];
		expect(passedOptions.minVersion).toBe('TLSv1.2');
		expect(passedOptions.requestCert).toBe(true);
		expect(passedOptions.rejectUnauthorized).toBe(true);
		expect(passedOptions.ca).toBeDefined();
		expect(server.listenerCount('error')).toBeGreaterThanOrEqual(1);
		expect(server.listenerCount('tlsClientError')).toBeGreaterThanOrEqual(1);
	});
});
