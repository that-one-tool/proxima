import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment, TenantHandle } from '../src/environment.ts';

const MESSAGE_TIMEOUT_MS = 5000;

/**
 * Passthrough sessions end-to-end: MULTI/EXEC transactions (each queued command is still prefixed on
 * its own frame and replies stay aligned) and pub/sub (channels pass through un-namespaced; once a
 * session subscribes the response stripper is disabled fail-safe, so payloads are never rewritten).
 */
describe('transactions and pub/sub through the proxy', () => {
	let env: IntegrationEnvironment;
	let tenant: TenantHandle;

	before(async () => {
		env = await startEnvironment({ acme: 'acme:' });
		tenant = env.tenants.acme;
	});

	after(async () => {
		await env.stop();
	});

	it('MULTI/EXEC prefixes queued commands and keeps replies aligned', async () => {
		const results = await tenant.client.multi().set('tx', 'committed').get('tx').exec();

		assert.ok(results, 'EXEC must return one result per queued command');
		assert.deepEqual(results[0], [null, 'OK']);
		assert.deepEqual(results[1], [null, 'committed']);
		assert.equal(await env.directClient.get('acme:tx'), 'committed', 'the queued SET must land under the tenant prefix');
		assert.equal(await env.directClient.exists('tx'), 0, 'the queued SET must not leak unprefixed');
	});

	it('a published message is delivered through the proxy with its payload intact', async () => {
		const subscriber = tenant.client.duplicate();
		try {
			const received = new Promise<{ channel: string; message: string }>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`No pub/sub message within ${MESSAGE_TIMEOUT_MS}ms`)), MESSAGE_TIMEOUT_MS);
				subscriber.on('message', (channel: string, message: string) => {
					clearTimeout(timer);
					resolve({ channel, message });
				});
			});
			await subscriber.subscribe('alerts');

			// The payload deliberately starts with the tenant prefix bytes: after SUBSCRIBE the response
			// stripper is disabled fail-safe, so the message must arrive verbatim, never un-prefixed.
			const payload = `${tenant.prefix}not-a-key-payload`;
			await tenant.client.publish('alerts', payload);

			const delivered = await received;
			assert.equal(delivered.channel, 'alerts');
			assert.equal(delivered.message, payload, 'pub/sub payloads must never be rewritten');
		} finally {
			subscriber.disconnect();
		}
	});
});
