import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

const REDIS_IMAGE = 'redis:7.4.1-alpine3.20';
const REDIS_CONTAINER_PORT = 6379;

export interface StartedRedis {
	host: string;
	port: number;
	container: StartedTestContainer;
}

/**
 * Starts a real Redis container as the upstream the proxy forwards to. The image matches the
 * docker-compose `redis` service so the integration upstream mirrors local development.
 */
export async function startRedis(): Promise<StartedRedis> {
	const container = await new GenericContainer(REDIS_IMAGE)
		.withExposedPorts(REDIS_CONTAINER_PORT)
		.withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
		.start();

	return {
		host: container.getHost(),
		port: container.getMappedPort(REDIS_CONTAINER_PORT),
		container,
	};
}
