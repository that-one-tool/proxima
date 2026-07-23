import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment, TenantHandle } from '../src/environment.ts';

const BURST_SIZE = 50;

async function writeBurst(client: Redis, keyspace: string): Promise<void> {
	const pipeline = client.pipeline();
	for (let index = 0; index < BURST_SIZE; index++) {
		pipeline.set(`${keyspace}:${index}`, String(index));
	}
	await pipeline.exec();
}

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

	it('a binary value with embedded CRLF and RESP type bytes round-trips losslessly', async () => {
		const binaryValue = Buffer.from([0x00, 0x0d, 0x0a, 0x24, 0x2a, 0x35, 0x0d, 0x0a, 0xff, 0x01]);
		await tenant.client.set('bin-value', binaryValue);

		assert.deepEqual(await tenant.client.getBuffer('bin-value'), binaryValue, 'client read must be byte-identical');
		assert.deepEqual(await env.directClient.getBuffer('acme:bin-value'), binaryValue, 'stored bytes must be exactly the original');
	});

	it('a binary key is prefixed without corrupting its bytes', async () => {
		const binaryKey = Buffer.from([0xfa, 0x0d, 0x0a, 0x00, 0x62]);
		await tenant.client.set(binaryKey, 'v');

		const storedValue = await env.directClient.getBuffer(Buffer.concat([Buffer.from('acme:', 'latin1'), binaryKey]));
		assert.deepEqual(storedValue, Buffer.from('v'), 'the key must be stored as prefix bytes + original key bytes');
	});

	// Each proxy session gets its own transformer instances; interleaved traffic from two sockets
	// must never mix reassembly buffers or correlation queues.
	it('two concurrent clients on one tenant port keep their sessions isolated', async () => {
		const second = tenant.client.duplicate();
		try {
			await Promise.all([writeBurst(tenant.client, 'conc-a'), writeBurst(second, 'conc-b')]);
		} finally {
			second.disconnect();
		}

		for (let index = 0; index < BURST_SIZE; index++) {
			assert.equal(await env.directClient.get(`acme:conc-a:${index}`), String(index));
			assert.equal(await env.directClient.get(`acme:conc-b:${index}`), String(index));
		}
	});

	it('the trusted HTTP port serves the healthcheck', async () => {
		const response = await fetch(`http://127.0.0.1:${env.httpPort}/api/v1/healthcheck`);

		assert.equal(response.status, 200);
		const body = (await response.json()) as { status?: string };
		assert.equal(body.status, 'ok');
	});

	// Key-carrying replies: BLPOP/LMPOP return the source key, XREAD returns stream names. The proxy
	// must un-prefix exactly those positions and never the values sitting next to them.
	it('BLPOP returns the key name un-prefixed and never rewrites the popped value', async () => {
		await tenant.client.lpush('queue', `${tenant.prefix}not-a-key`);

		const popped = await tenant.client.blpop('queue', 1);

		assert.deepEqual(popped, ['queue', `${tenant.prefix}not-a-key`], 'key un-prefixed, prefix-shaped value untouched');
	});

	it('LMPOP returns the source key name un-prefixed', async () => {
		await tenant.client.rpush('mq', 'a', 'b');

		const reply = (await tenant.client.call('LMPOP', '1', 'mq', 'LEFT')) as [string, string[]];

		assert.equal(reply[0], 'mq', 'the source key must be un-prefixed');
		assert.deepEqual(reply[1], ['a']);
	});

	it('XREAD returns stream names un-prefixed', async () => {
		await tenant.client.xadd('stream', '*', 'field', 'value');

		const replies = await tenant.client.xread('COUNT', 10, 'STREAMS', 'stream', '0');

		assert.ok(replies, 'XREAD must return the stream entries');
		assert.equal(replies[0][0], 'stream', 'the stream name must be un-prefixed');
	});
});
