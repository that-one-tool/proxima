import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment, TenantHandle } from '../src/environment.ts';

/**
 * End-to-end prefixing: a client speaks plain Redis through the proxy; we assert (via a direct
 * Redis client) that keys land under the tenant prefix, and that reads come back with the prefix
 * stripped. These cover the proxy's core promise and are expected to pass against current code.
 */
describe('proxy key prefixing (end-to-end)', () => {
	let env: IntegrationEnvironment;
	let tenant: TenantHandle;

	before(async () => {
		env = await startEnvironment({ acme: 'acme:' });
		tenant = env.tenants.acme;
	});

	after(async () => {
		await env.stop();
	});

	it('SET stores the key prefixed, GET returns the original value', async () => {
		await tenant.client.set('color', 'blue');

		assert.equal(await env.directClient.get('acme:color'), 'blue', 'key must be stored under the tenant prefix');
		assert.equal(await env.directClient.exists('color'), 0, 'unprefixed key must not exist');
		assert.equal(await tenant.client.get('color'), 'blue', 'client read must round-trip the original value');
	});

	it('MSET / MGET prefix every key', async () => {
		await tenant.client.mset({ one: '1', two: '2', three: '3' });

		assert.equal(await env.directClient.get('acme:one'), '1');
		assert.equal(await env.directClient.get('acme:two'), '2');
		assert.equal(await env.directClient.get('acme:three'), '3');
		assert.deepEqual(await tenant.client.mget('one', 'two', 'three'), ['1', '2', '3']);
	});

	it('DEL removes the prefixed key', async () => {
		await tenant.client.set('temp', 'x');
		assert.equal(await env.directClient.exists('acme:temp'), 1);

		await tenant.client.del('temp');
		assert.equal(await env.directClient.exists('acme:temp'), 0);
	});

	it('HSET / HGET operate on the prefixed hash key', async () => {
		await tenant.client.hset('profile', 'name', 'ada', 'role', 'engineer');

		assert.equal(await env.directClient.hget('acme:profile', 'name'), 'ada');
		assert.equal(await env.directClient.exists('profile'), 0);
		assert.equal(await tenant.client.hget('profile', 'role'), 'engineer');
	});

	it('EXPIRE applies to the prefixed key', async () => {
		await tenant.client.set('session', 'live');
		await tenant.client.expire('session', 1000);

		const ttl = await env.directClient.ttl('acme:session');
		assert.ok(ttl > 0 && ttl <= 1000, `expected a positive TTL on the prefixed key, got ${ttl}`);
	});

	it('pipelined commands in one flush all land prefixed', async () => {
		const pipeline = tenant.client.pipeline();
		for (let index = 0; index < 25; index++) {
			pipeline.set(`batch:${index}`, String(index));
		}
		await pipeline.exec();

		for (let index = 0; index < 25; index++) {
			assert.equal(await env.directClient.get(`acme:batch:${index}`), String(index));
		}
	});
});
