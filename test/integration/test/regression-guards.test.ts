import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment, TenantHandle } from '../src/environment.ts';
import { EMPTY_ARRAY_FRAME, respCommand, sendRaw } from '../src/resp-raw.ts';

/**
 * REGRESSION GUARDS — these assert the CORRECT behavior for three correctness bugs found in an earlier
 * review and since fixed (frame reassembly, empty-array pipeline handling, correlated response
 * stripping). They are EXPECTED TO PASS; a red result here means a fix has regressed.
 *
 *   - big value spanning TCP segments      -> frame reassembly (the key stays prefixed)
 *   - pipeline poisoned by an empty array  -> a *0 frame no longer aborts prefixing
 *   - value whose bytes start with prefix  -> correlated stripping leaves values intact
 */
describe('regression guards for previously-fixed correctness bugs', () => {
	let env: IntegrationEnvironment;
	let tenant: TenantHandle;

	before(async () => {
		env = await startEnvironment({ acme: 'acme:' });
		tenant = env.tenants.acme;
	});

	after(async () => {
		await env.stop();
	});

	// Frame reassembly: a value larger than one socket read forces the RESP frame across TCP segments.
	// Without reassembly, the per-chunk transform cannot parse the whole frame and the key goes out UNPREFIXED.
	it('a >64KB value still stores the key under the tenant prefix', async () => {
		const bigValue = 'x'.repeat(200 * 1024);
		await tenant.client.set('big', bigValue);

		assert.equal(await env.directClient.get('acme:big'), bigValue, 'large-value key must still be prefixed');
		assert.equal(await env.directClient.exists('big'), 0, 'large-value key must not leak unprefixed');
		assert.equal(await tenant.client.get('big'), bigValue, 'large value must round-trip intact');
	});

	// Empty-array handling: an empty multibulk (*0) mid-pipeline must not make the parser bail, or every
	// command after it in the same write is forwarded unprefixed.
	it('a command following an empty-array frame is still prefixed', async () => {
		const payload = Buffer.concat([
			respCommand('SET', 'poison-before', 'a'),
			EMPTY_ARRAY_FRAME,
			respCommand('SET', 'poison-after', 'b'),
		]);
		await sendRaw(env.host, tenant.port, payload);

		assert.equal(await env.directClient.get('acme:poison-before'), 'a', 'command before the empty frame is prefixed');
		assert.equal(await env.directClient.get('acme:poison-after'), 'b', 'command after the empty frame must also be prefixed');
		assert.equal(await env.directClient.exists('poison-after'), 0, 'trailing command must not leak unprefixed');
	});

	// Correlated stripping: only replies to key-returning commands are un-prefixed. A stored VALUE that
	// happens to begin with the tenant prefix must come back verbatim, never with those bytes stripped.
	it('a value whose bytes start with the tenant prefix round-trips uncorrupted', async () => {
		const value = `${tenant.prefix}legit-payload`;
		await tenant.client.set('vp', value);

		assert.equal(await env.directClient.get('acme:vp'), value, 'value is not a key, so it must be stored verbatim');
		assert.equal(await tenant.client.get('vp'), value, 'GET must return the value uncorrupted (prefix bytes preserved)');
	});
});
