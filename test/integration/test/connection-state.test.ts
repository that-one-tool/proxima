import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startEnvironment } from '../src/environment.ts';
import type { IntegrationEnvironment } from '../src/environment.ts';
import { respCommand, sendRaw } from '../src/resp-raw.ts';

/**
 * Connection-state isolation across pooled reuse (destroy-on-dirty). With a single upstream connection in
 * the pool, the next session necessarily reuses the very socket the previous one used. A session that
 * mutates connection state (here `SELECT` to a non-default DB) must NOT leak it to that next session: the
 * proxy destroys the dirty connection on release and reconnects a clean one. Expected to pass on current code.
 */
describe('connection-state isolation across pooled reuse', () => {
	let env: IntegrationEnvironment;

	before(async () => {
		// A single pooled connection forces the second session onto the exact socket the first one used.
		env = await startEnvironment({ solo: 'solo:' }, { minPoolConnections: 1, maxPoolConnections: 1 });
	});

	after(async () => {
		await env.stop();
	});

	it('a SELECT on one session does not move the next session to a non-default DB', async () => {
		const port = env.tenants.solo.port;

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
