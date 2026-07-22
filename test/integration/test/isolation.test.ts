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

	it('KEYS is scoped to the tenant namespace and returns un-prefixed names', async () => {
		await env.tenants.tenantA.client.set('scoped', '1');
		await env.tenants.tenantA.client.set('a-only-key', 'x');
		await env.tenants.tenantB.client.set('b-only-key', '2');

		const aKeys = await env.tenants.tenantA.client.keys('*');
		assert.ok(aKeys.includes('scoped'), 'tenant A sees its own keys');
		assert.ok(aKeys.includes('a-only-key'));
		assert.ok(!aKeys.includes('b-only-key'), 'tenant A must not see tenant B keys via KEYS');
		assert.ok(
			!aKeys.some((key) => key.startsWith('tenant-a:') || key.startsWith('tenant-b:')),
			'returned key names must have the tenant prefix stripped',
		);

		const bKeys = await env.tenants.tenantB.client.keys('*');
		assert.ok(!bKeys.includes('a-only-key'), 'tenant B must not see tenant A keys via KEYS');
	});

	it('SCAN stays within the tenant namespace', async () => {
		await env.tenants.tenantA.client.set('scan-a', '1');
		await env.tenants.tenantB.client.set('scan-b', '2');

		const seen: string[] = [];
		let cursor = '0';
		do {
			const [next, batch] = await env.tenants.tenantA.client.scan(cursor);
			cursor = next;
			seen.push(...batch);
		} while (cursor !== '0');

		assert.ok(seen.includes('scan-a'), 'SCAN surfaces tenant A keys un-prefixed');
		assert.ok(!seen.includes('scan-b'), 'SCAN must not surface tenant B keys');
	});
});
