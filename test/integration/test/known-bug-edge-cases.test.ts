import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment, TenantHandle } from '../src/environment.ts';
import { EMPTY_ARRAY_FRAME, respCommand, sendRaw } from '../src/resp-raw.ts';

/**
 * REGRESSION GUARDS — these assert the CORRECT behavior for three correctness bugs that have since been
 * fixed (frame reassembly, empty-array pipeline handling, correlated response stripping). Each maps to a
 * finding in REVIEW-second-pass-2026-07-21.md and is EXPECTED TO PASS; a red result here means the fix
 * has regressed.
 *
 *   - big value spanning TCP segments      -> Finding #1 (frame reassembly; key stays prefixed)
 *   - pipeline poisoned by an empty array  -> Finding #2 (a *0 frame no longer aborts prefixing)
 *   - value whose bytes start with prefix  -> Finding #3 (correlated stripping leaves values intact)
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

	// Finding #1: a value larger than one socket read forces the RESP frame across TCP segments.
	// The per-chunk transform can no longer parse the whole frame and forwards the key UNPREFIXED.
	it('a >64KB value still stores the key under the tenant prefix', async () => {
		const bigValue = 'x'.repeat(200 * 1024);
		await tenant.client.set('big', bigValue);

		assert.equal(await env.directClient.get('acme:big'), bigValue, 'large-value key must still be prefixed');
		assert.equal(await env.directClient.exists('big'), 0, 'large-value key must not leak unprefixed');
		assert.equal(await tenant.client.get('big'), bigValue, 'large value must round-trip intact');
	});

	// Finding #2: an empty multibulk (*0) mid-pipeline makes the parser bail and forward the REST raw,
	// so every command after it in the same write is forwarded unprefixed.
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

	// Finding #3: response stripping is blind byte-matching. A stored VALUE that happens to begin with
	// the tenant prefix gets those bytes stripped on the way back, corrupting the payload.
	it('a value whose bytes start with the tenant prefix round-trips uncorrupted', async () => {
		const value = `${tenant.prefix}legit-payload`;
		await tenant.client.set('vp', value);

		assert.equal(await env.directClient.get('acme:vp'), value, 'value is not a key, so it must be stored verbatim');
		assert.equal(await tenant.client.get('vp'), value, 'GET must return the value uncorrupted (prefix bytes preserved)');
	});
});
