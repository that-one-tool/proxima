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
});
