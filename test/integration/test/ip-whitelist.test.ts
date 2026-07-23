import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { getFreePort } from '../src/ports.ts';
import { startProxima } from '../src/proxima-harness.ts';
import type { StartedProxima } from '../src/proxima-harness.ts';
import { startRedis } from '../src/redis-container.ts';
import type { StartedRedis } from '../src/redis-container.ts';
import { respCommand, sendRaw } from '../src/resp-raw.ts';

/**
 * IP whitelist enforcement end-to-end: a proxy whose whitelist does not include the client's address
 * must drop the connection before a single byte reaches the shared service.
 */
describe('IP whitelist enforcement', () => {
	let redis: StartedRedis;
	let proxima: StartedProxima;
	let directClient: Redis;
	let port: number;

	before(async () => {
		redis = await startRedis();
		port = await getFreePort();
		proxima = await startProxima({
			forwardHost: redis.host,
			forwardPort: redis.port,
			httpPort: await getFreePort(),
			tenants: [{ port, prefix: 'walled:' }],
			ipWhitelist: '203.0.113.1', // TEST-NET-3 — never the loopback the test client connects from
		});
		directClient = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: 3 });
	});

	after(async () => {
		directClient.disconnect();
		await proxima.stop();
		await redis.container.stop();
	});

	it('disconnects a non-whitelisted client without executing its command', async () => {
		const response = await sendRaw('127.0.0.1', port, respCommand('SET', 'sneak', 'v'));

		assert.equal(response.length, 0, 'a rejected client must receive no bytes');
		assert.equal(await directClient.exists('walled:sneak'), 0, 'the command must not reach the service prefixed');
		assert.equal(await directClient.exists('sneak'), 0, 'the command must not reach the service at all');
	});
});
