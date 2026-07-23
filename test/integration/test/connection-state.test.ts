import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment } from '../src/environment.ts';
import { respCommand, sendRaw } from '../src/resp-raw.ts';

/**
 * Pooled upstream connection lifecycle. With a single upstream connection in the pool, the next
 * session necessarily reuses (or replaces) the very socket the previous one used, which makes both
 * sides of the release policy observable from outside:
 *   - a session that leaves no connection state behind is recycled (same upstream CLIENT ID);
 *   - a session that mutates connection state (here `SELECT` to a non-default DB) is destroyed on
 *     release and replaced by a clean one, so the state never leaks to the next session (destroy-on-dirty).
 */
describe('pooled upstream connection lifecycle', () => {
	let env: IntegrationEnvironment;
	let port: number;

	before(async () => {
		// A single pooled connection forces every session onto the same upstream slot.
		env = await startEnvironment({ solo: 'solo:' }, { minPoolConnections: 1, maxPoolConnections: 1 });
		port = env.tenants.solo.port;
	});

	after(async () => {
		await env.stop();
	});

	it('a clean session hands its upstream socket back for reuse by the next session', async () => {
		const first = new Redis({ host: env.host, port, maxRetriesPerRequest: 3 });
		const firstUpstreamId = await first.call('CLIENT', 'ID');
		first.disconnect();

		const second = new Redis({ host: env.host, port, maxRetriesPerRequest: 3 });
		try {
			const secondUpstreamId = await second.call('CLIENT', 'ID');
			assert.equal(secondUpstreamId, firstUpstreamId, 'both sessions must observe the same recycled upstream connection');
		} finally {
			second.disconnect();
		}
	});

	it('a SELECT on one session does not move the next session to a non-default DB', async () => {
		// Session 1: switch to DB 5 and write there, then disconnect — the pooled socket is now "dirty".
		await sendRaw(env.host, port, Buffer.concat([respCommand('SELECT', '5'), respCommand('SET', 'akey', 'aval')]));

		// Session 2 reuses the pool's single slot. If the dirty socket had been recycled, this write would
		// also land in DB 5; with destroy-on-dirty it lands in the default DB 0.
		await sendRaw(env.host, port, respCommand('SET', 'bkey', 'bval'));

		assert.equal(await env.directClient.get('solo:bkey'), 'bval', 'second session must write to the default DB 0');

		await env.directClient.select(5);
		try {
			assert.equal(await env.directClient.get('solo:akey'), 'aval', 'first session did switch to DB 5 (sanity)');
			assert.equal(await env.directClient.get('solo:bkey'), null, 'second session must NOT have leaked into DB 5');
		} finally {
			await env.directClient.select(0);
		}
	});
});
