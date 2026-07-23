import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment } from '../src/environment.ts';

/**
 * C1 — default-deny command isolation. A command the proxy cannot safely prefix must never reach the
 * shared service unmodified: it is rewritten to an unknown-command frame, so the client gets an error
 * and no cross-tenant read/enumerate/destroy is possible. Expected to pass against current code.
 */
describe('command isolation (default-deny)', () => {
	let env: IntegrationEnvironment;

	before(async () => {
		env = await startEnvironment({ tenantA: 'tenant-a:', tenantB: 'tenant-b:' });
	});

	after(async () => {
		await env.stop();
	});

	it('denies FLUSHALL so one tenant cannot wipe the shared instance', async () => {
		await env.tenants.tenantA.client.set('keep', 'v');

		await assert.rejects(env.tenants.tenantB.client.call('FLUSHALL'), /unknown command|denied/i);

		assert.equal(await env.directClient.get('tenant-a:keep'), 'v', 'data must survive the denied FLUSHALL');
	});

	it('denies SUBSTR, which would otherwise read another tenant key verbatim', async () => {
		await env.tenants.tenantA.client.set('doc', 'topsecret');

		await assert.rejects(env.tenants.tenantB.client.call('SUBSTR', 'tenant-a:doc', '0', '-1'), /unknown command|denied/i);
	});

	it('denies RANDOMKEY (cannot be scoped to a tenant prefix)', async () => {
		await assert.rejects(env.tenants.tenantA.client.call('RANDOMKEY'), /unknown command|denied/i);
	});

	it('denies an EVAL that references another tenant key', async () => {
		await env.tenants.tenantA.client.set('secret', 'nope');

		await assert.rejects(
			env.tenants.tenantB.client.call('EVAL', "return redis.call('get', KEYS[1])", '1', 'tenant-a:secret'),
			/unknown command|denied/i,
		);
	});

	// The denial sentinel exists precisely to preserve one-reply-per-command ordering: the rewritten
	// frame still draws one (error) reply, so nothing after it can desync or leak unprefixed.
	it('a denial does not desync later replies on the same connection', async () => {
		const client = env.tenants.tenantA.client;
		await assert.rejects(client.call('FLUSHALL'), /unknown command|denied/i);

		await client.set('after-deny', 'ok');
		assert.equal(await client.get('after-deny'), 'ok', 'the connection must stay usable after a denial');
		assert.equal(await env.directClient.get('tenant-a:after-deny'), 'ok', 'commands after a denial must still be prefixed');
	});

	it('a pipeline mixing denied and allowed commands keeps every reply aligned', async () => {
		const pipeline = env.tenants.tenantA.client.pipeline();
		pipeline.set('mix-before', 'v1');
		pipeline.call('RANDOMKEY');
		pipeline.set('mix-after', 'v2');
		const results = await pipeline.exec();

		assert.ok(results, 'pipeline must return one result per command');
		assert.deepEqual(results[0], [null, 'OK'], 'command before the denial succeeds');
		assert.match(String(results[1][0]), /unknown command|denied/i, 'the denied command errors in place');
		assert.deepEqual(results[2], [null, 'OK'], 'command after the denial succeeds');
		assert.equal(await env.directClient.get('tenant-a:mix-before'), 'v1');
		assert.equal(await env.directClient.get('tenant-a:mix-after'), 'v2');
	});
});
