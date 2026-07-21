import { ForwardServiceOptions } from '../connection-pool/types';
import { ContextualError } from '../errors';
import { Logger } from '../logging';
import { TlsOptions, TlsServerClientOptions } from '../types';

const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_TRUSTED_HTTP_PORT = 9101;
const DEFAULT_FORWARD_SERVICE_PORT = 6379;
const DEFAULT_MIN_POOL_CONNECTIONS = 5;
const DEFAULT_MAX_POOL_CONNECTIONS = 20;
const DEFAULT_IDLE_CONNECTION_TIMEOUT_MS = 30000;
const DEFAULT_CONNECTION_CLEANUP_INTERVAL_MS = 30000;
const DEFAULT_ACQUIRE_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_LISTENING_PORT = 7000;

interface IntRange {
	min?: number;
	max?: number;
}

export interface Config {
	ipBlacklist: string[];
	ipWhitelist: string[];
	portMapping: Record<number, string>;
	forwardServiceOptions: ForwardServiceOptions;
	tlsClientOptions: TlsServerClientOptions;
	tlsServerOptions: TlsServerClientOptions;
	trustedHttpPort: number;
	version: string;
}

export function getConfig(): Config {
	try {
		return {
			ipBlacklist: getEnvList('IP_BLACKLIST'),
			ipWhitelist: getEnvList('IP_WHITELIST'),
			portMapping: getPortMapping(),
			forwardServiceOptions: getForwardServiceOptions(),
			tlsClientOptions: getTlsClientOptions(),
			tlsServerOptions: getTlsServerOptions(),
			trustedHttpPort: getEnvInt('TRUSTED_HTTP_PORT', DEFAULT_TRUSTED_HTTP_PORT, { min: MIN_PORT, max: MAX_PORT }),
			version: process.env.VERSION || 'unknown',
		};
	} catch (error) {
		Logger.getInstance().error('Error parsing environment variables', { error });
		process.exit(1);
	}
}

function getEnvList(name: string): string[] {
	return (process.env[name] ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function getEnvBool(name: string, defaultValue: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === '') {
		return defaultValue;
	}
	return raw === 'true';
}

function parseEnvInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (!raw) {
		return defaultValue;
	}
	const value = parseInt(raw, 10);
	if (Number.isNaN(value)) {
		throw new ContextualError(`Invalid integer for environment variable ${name}`, { context: { name, raw } });
	}
	return value;
}

function getEnvInt(name: string, defaultValue: number, range: IntRange = {}): number {
	const value = parseEnvInt(name, defaultValue);
	assertInRange(name, value, range);
	return value;
}

function assertInRange(name: string, value: number, range: IntRange): void {
	const min = range.min ?? Number.MIN_SAFE_INTEGER;
	const max = range.max ?? Number.MAX_SAFE_INTEGER;
	if (value < min || value > max) {
		throw new ContextualError(`Environment variable ${name} (${value}) is out of range [${min}, ${max}]`, {
			context: { name, value, min, max },
		});
	}
}

function getForwardServiceOptions(): ForwardServiceOptions {
	const minPoolConnections = getEnvInt('FORWARD_SERVICE_MIN_POOL_CONNECTIONS', DEFAULT_MIN_POOL_CONNECTIONS, { min: 0 });
	const maxPoolConnections = getEnvInt('FORWARD_SERVICE_MAX_POOL_CONNECTIONS', DEFAULT_MAX_POOL_CONNECTIONS, { min: 1 });
	assertPoolBounds(minPoolConnections, maxPoolConnections);

	return {
		host: process.env.FORWARD_SERVICE_HOST || '127.0.0.1',
		port: getEnvInt('FORWARD_SERVICE_PORT', DEFAULT_FORWARD_SERVICE_PORT, { min: MIN_PORT, max: MAX_PORT }),
		name: process.env.FORWARD_SERVICE_NAME || 'unknown-forward-service',
		minPoolConnections,
		maxPoolConnections,
		idleConnectionTimeoutMs: getEnvInt('FORWARD_SERVICE_IDLE_CONNECTION_TIMEOUT_MS', DEFAULT_IDLE_CONNECTION_TIMEOUT_MS, { min: 0 }),
		connectionCleanupIntervalMs: getEnvInt('FORWARD_SERVICE_CONNECTION_CLEANUP_INTERVAL_MS', DEFAULT_CONNECTION_CLEANUP_INTERVAL_MS, {
			min: 0,
		}),
		acquireConnectionTimeoutMs: getEnvInt('FORWARD_SERVICE_ACQUIRE_CONNECTION_TIMEOUT_MS', DEFAULT_ACQUIRE_CONNECTION_TIMEOUT_MS, {
			min: 0,
		}),
		maxRetries: getEnvInt('FORWARD_SERVICE_MAX_RETRIES', DEFAULT_MAX_RETRIES, { min: 0 }),
	};
}

function assertPoolBounds(min: number, max: number): void {
	if (min > max) {
		throw new ContextualError('FORWARD_SERVICE_MIN_POOL_CONNECTIONS must be less than or equal to FORWARD_SERVICE_MAX_POOL_CONNECTIONS', {
			context: { min, max },
		});
	}
}

function getPortMapping(): Record<number, string> {
	const explicit = parseExplicitPortMapping(process.env.PORT_MAPPING);
	return Object.keys(explicit).length > 0 ? explicit : getDefaultPortMapping();
}

function parseExplicitPortMapping(raw: string | undefined): Record<number, string> {
	const portMapping: Record<number, string> = {};
	for (const mapping of raw?.split(',') ?? []) {
		addPortMappingEntry(portMapping, mapping);
	}
	return portMapping;
}

function addPortMappingEntry(portMapping: Record<number, string>, mapping: string): void {
	const entry = parsePortMappingEntry(mapping);
	if (!entry) {
		return;
	}
	if (portMapping[entry.port] !== undefined) {
		Logger.getInstance().warn(`Duplicate PORT_MAPPING entry for port ${entry.port}; later value overrides the earlier one`);
	}
	portMapping[entry.port] = ensureTrailingColon(entry.prefix);
}

function parsePortMappingEntry(mapping: string): { port: number; prefix: string } | undefined {
	const separatorIndex = mapping.indexOf(':');
	const port = parsePort(mapping.slice(0, separatorIndex));
	const prefix = mapping.slice(separatorIndex + 1);
	if (separatorIndex === -1 || port === undefined || prefix === '') {
		return undefined;
	}
	return { port, prefix };
}

function parsePort(raw: string): number | undefined {
	const port = parseInt(raw, 10);
	return isValidPort(port) ? port : undefined;
}

function isValidPort(port: number): boolean {
	return !Number.isNaN(port) && port >= MIN_PORT && port <= MAX_PORT;
}

function getDefaultPortMapping(): Record<number, string> {
	const port = getEnvInt('DEFAULT_LISTENING_PORT', DEFAULT_LISTENING_PORT, { min: MIN_PORT, max: MAX_PORT });
	return { [port]: ensureTrailingColon(process.env.DEFAULT_PORT_MAPPING || 'default') };
}

function ensureTrailingColon(prefix: string): string {
	return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

function getTlsClientOptions(): TlsServerClientOptions {
	return buildTlsOptions('TLS_CLIENT_ENABLED', {
		certPath: process.env.TLS_CLIENT_CERT_PATH || '',
		keyPath: process.env.TLS_CLIENT_KEY_PATH || '',
		caPath: process.env.TLS_CLIENT_CA_PATH || '',
		rejectUnauthorized: getEnvBool('TLS_CLIENT_REJECT_UNAUTHORIZED', true),
	});
}

function getTlsServerOptions(): TlsServerClientOptions {
	return buildTlsOptions('TLS_SERVER_ENABLED', {
		certPath: process.env.TLS_SERVER_CERT_PATH || '',
		keyPath: process.env.TLS_SERVER_KEY_PATH || '',
		caPath: process.env.TLS_SERVER_CA_PATH || '',
		requestCert: getEnvBool('TLS_SERVER_REQUEST_CERT', false),
		rejectUnauthorized: getEnvBool('TLS_SERVER_REJECT_UNAUTHORIZED', true),
	});
}

function buildTlsOptions(enabledVar: string, tlsOptions: TlsOptions): TlsServerClientOptions {
	return getEnvBool(enabledVar, false) ? { useTls: true, tlsOptions } : { useTls: false, tlsOptions };
}
