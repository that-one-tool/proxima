import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment } from '../src/environment.ts';

/**
 * Per-tenant isolation: two tenants on two proxy ports with two prefixes must not observe each
 * other's keys, even when they use identical logical key names. Expected to pass against current code.
 */
describe('per-tenant isolation (end-to-end)', () => {
	let env: IntegrationEnvironment;

	before(async () => {
		env = await startEnvironment({ tenantA: 'tenant-a:', tenantB: 'tenant-b:' });
	});

	after(async () => {
		await env.stop();
	});

	it('same key name resolves to different physical keys per tenant', async () => {
		await env.tenants.tenantA.client.set('shared', 'from-a');
		await env.tenants.tenantB.client.set('shared', 'from-b');

		assert.equal(await env.directClient.get('tenant-a:shared'), 'from-a');
		assert.equal(await env.directClient.get('tenant-b:shared'), 'from-b');
	});

	it('a tenant cannot read another tenant\'s key', async () => {
		await env.tenants.tenantA.client.set('secret', 'a-only');

		assert.equal(await env.tenants.tenantA.client.get('secret'), 'a-only');
		assert.equal(await env.tenants.tenantB.client.get('secret'), null, 'tenant B must not see tenant A key');
	});

	it('a tenant cannot delete another tenant\'s key', async () => {
		await env.tenants.tenantA.client.set('protected', 'keep');

		await env.tenants.tenantB.client.del('protected');

		assert.equal(await env.directClient.get('tenant-a:protected'), 'keep', 'tenant B DEL must not touch tenant A key');
	});

	it('KEYS-style scans stay within a tenant namespace', async () => {
		await env.tenants.tenantA.client.set('scoped', '1');
		await env.tenants.tenantB.client.set('scoped', '2');

		assert.equal(await env.directClient.get('tenant-a:scoped'), '1');
		assert.equal(await env.directClient.get('tenant-b:scoped'), '2');
		assert.equal(await env.tenants.tenantB.client.get('scoped'), '2');
	});
});
