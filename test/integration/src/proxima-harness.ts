import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { waitForPort } from './ports.ts';

const require = createRequire(import.meta.url);
const READY_TIMEOUT_MS = 15000;
const TERMINATE_GRACE_MS = 3000;

export interface TenantMapping {
	/** Loopback port the proxy listens on for this tenant. */
	port: number;
	/** Key prefix applied to this tenant's traffic (a trailing colon is added by the service if missing). */
	prefix: string;
}

export interface ProximaOptions {
	forwardHost: string;
	forwardPort: number;
	httpPort: number;
	tenants: TenantMapping[];
	ipWhitelist?: string;
	/** Force the upstream pool size (both set to 1 makes connection reuse across sessions deterministic). */
	minPoolConnections?: number;
	maxPoolConnections?: number;
}

export interface StartedProxima {
	process: ChildProcess;
	stop(): Promise<void>;
}

/**
 * Spawns the real built RESP service (`packages/resp/dist/index.js`) as a child process, configured
 * via the same environment variables production uses, and resolves once every tenant port accepts TCP.
 */
export async function startProxima(options: ProximaOptions): Promise<StartedProxima> {
	const entrypoint = require.resolve('@that-one-tool/proxima-resp');
	const child = spawn(process.execPath, [entrypoint], {
		env: buildEnv(options),
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const logs: string[] = [];
	child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
	child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));

	await waitForReady(child, options.tenants, logs);

	return { process: child, stop: () => terminate(child) };
}

function buildEnv(options: ProximaOptions): NodeJS.ProcessEnv {
	const portMapping = options.tenants.map((tenant) => `${tenant.port}:${tenant.prefix}`).join(',');
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT_MAPPING: portMapping,
		FORWARD_SERVICE_HOST: options.forwardHost,
		FORWARD_SERVICE_PORT: String(options.forwardPort),
		IP_WHITELIST: options.ipWhitelist ?? '*.*.*.*',
		TRUSTED_HTTP_PORT: String(options.httpPort),
	};
	if (options.minPoolConnections !== undefined) {
		env.FORWARD_SERVICE_MIN_POOL_CONNECTIONS = String(options.minPoolConnections);
	}
	if (options.maxPoolConnections !== undefined) {
		env.FORWARD_SERVICE_MAX_POOL_CONNECTIONS = String(options.maxPoolConnections);
	}
	return env;
}

function waitForReady(child: ChildProcess, tenants: TenantMapping[], logs: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const onExit = (code: number | null): void => {
			reject(new Error(`Proxima exited before becoming ready (code ${code ?? 'null'}).\n${logs.join('')}`));
		};
		child.once('exit', onExit);

		void Promise.all(tenants.map((tenant) => waitForPort('127.0.0.1', tenant.port, READY_TIMEOUT_MS)))
			.then(() => {
				child.removeListener('exit', onExit);
				resolve();
			})
			.catch((error: unknown) => {
				child.removeListener('exit', onExit);
				reject(asError(error));
			});
	});
}

function terminate(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once('exit', () => resolve());
		child.kill('SIGTERM');
		setTimeout(() => {
			if (child.exitCode === null) {
				child.kill('SIGKILL');
			}
		}, TERMINATE_GRACE_MS).unref();
	});
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
