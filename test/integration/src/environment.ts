import { Redis } from 'ioredis';
import { getFreePort } from './ports.ts';
import { startProxima } from './proxima-harness.ts';
import type { StartedProxima } from './proxima-harness.ts';
import { startRedis } from './redis-container.ts';
import type { StartedRedis } from './redis-container.ts';

export interface TenantHandle {
	/** Proxy port dedicated to this tenant. */
	port: number;
	/** The exact key prefix the proxy stores this tenant's keys under (including the trailing colon). */
	prefix: string;
	/** ioredis client connected THROUGH the proxy. */
	client: Redis;
}

export interface IntegrationEnvironment {
	host: string;
	/** Trusted HTTP port of the spawned service (healthcheck / metrics). */
	httpPort: number;
	/** ioredis client connected DIRECTLY to the upstream Redis, for asserting what was actually stored. */
	directClient: Redis;
	tenants: Record<string, TenantHandle>;
	stop(): Promise<void>;
}

export interface EnvironmentOptions {
	/** Force the upstream pool size. Set both to 1 to make connection reuse across sessions deterministic. */
	minPoolConnections?: number;
	maxPoolConnections?: number;
}

/**
 * Brings up the full stack: a real Redis container, one spawned Proxima process listening on a
 * dedicated port per tenant, an ioredis client per tenant through the proxy, and a direct client
 * to Redis for verification. `prefixes` maps a tenant name to its key prefix (include the colon).
 */
export async function startEnvironment(
	prefixes: Record<string, string>,
	options: EnvironmentOptions = {},
): Promise<IntegrationEnvironment> {
	const redis = await startRedis();
	const plans = await planTenants(prefixes);
	const httpPort = await getFreePort();

	const proxima = await startProxima({
		forwardHost: redis.host,
		forwardPort: redis.port,
		httpPort,
		tenants: plans.map(({ port, prefix }) => ({ port, prefix })),
		minPoolConnections: options.minPoolConnections,
		maxPoolConnections: options.maxPoolConnections,
	});

	const tenants = connectTenants(plans);
	const directClient = new Redis({ host: redis.host, port: redis.port, maxRetriesPerRequest: 3 });
	await directClient.flushall();

	return {
		host: '127.0.0.1',
		httpPort,
		directClient,
		tenants,
		stop: () => stopAll(redis, proxima, directClient, tenants),
	};
}

interface TenantPlan {
	name: string;
	port: number;
	prefix: string;
}

async function planTenants(prefixes: Record<string, string>): Promise<TenantPlan[]> {
	const plans: TenantPlan[] = [];
	for (const name of Object.keys(prefixes)) {
		plans.push({ name, port: await getFreePort(), prefix: prefixes[name] });
	}
	return plans;
}

function connectTenants(plans: TenantPlan[]): Record<string, TenantHandle> {
	const tenants: Record<string, TenantHandle> = {};
	for (const plan of plans) {
		tenants[plan.name] = {
			port: plan.port,
			prefix: plan.prefix,
			// Lazy so an unused tenant client never pins a pooled upstream connection (each proxy session
			// leases one for its whole lifetime — with a pool of 1 an eager client would starve every other
			// session). ioredis still auto-connects on the first command, so tests use it transparently.
			client: new Redis({ host: '127.0.0.1', port: plan.port, maxRetriesPerRequest: 3, lazyConnect: true }),
		};
	}
	return tenants;
}

async function stopAll(
	redis: StartedRedis,
	proxima: StartedProxima,
	directClient: Redis,
	tenants: Record<string, TenantHandle>,
): Promise<void> {
	for (const tenant of Object.values(tenants)) {
		tenant.client.disconnect();
	}
	directClient.disconnect();
	await proxima.stop();
	await redis.container.stop();
}
