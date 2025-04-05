import { ForwardServiceOptions } from '../connection-pool/types';
import { TlsServerClientOptions } from '../types';

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
		const ipBlacklist = process.env.IP_BLACKLIST?.split(',') ?? [];
		const ipWhitelist = process.env.IP_WHITELIST?.split(',') ?? [];

		const portMapping = getPortMapping();

		const forwardServiceOptions = getForwardServiceOptions();
		const tlsServerOptions = getTlsServerOptions();
		const tlsClientOptions = getTlsClientOptions();
		const trustedHttpPort = parseInt(process.env.TRUSTED_HTTP_PORT ?? '9101', 10);
		const version = process.env.VERSION ?? 'unknown';

		return {
			ipBlacklist,
			ipWhitelist,
			portMapping,
			forwardServiceOptions,
			tlsClientOptions,
			tlsServerOptions,
			trustedHttpPort,
			version,
		};
	} catch (error) {
		console.error('Error parsing environment variables', error);
		process.exit(1);
	}
}

function getForwardServiceOptions(): ForwardServiceOptions {
	return {
		host: process.env.FORWARD_SERVICE_HOST || '127.0.0.1',
		port: parseInt(process.env.FORWARD_SERVICE_PORT ?? '6379', 10),
		name: process.env.FORWARD_SERVICE_NAME || 'unknown-forward-service',
		minPoolConnections: parseInt(process.env.FORWARD_SERVICE_MIN_POOL_CONNECTIONS || '5', 10),
		maxPoolConnections: parseInt(process.env.FORWARD_SERVICE_MAX_POOL_CONNECTIONS || '20', 10),
		idleConnectionTimeoutMs: parseInt(process.env.FORWARD_SERVICE_IDLE_CONNECTION_TIMEOUT_MS || '30000', 10),
		connectionCleanupIntervalMs: parseInt(process.env.FORWARD_SERVICE_CONNECTION_CLEANUP_INTERVAL_MS || '30000', 10),
		acquireConnectionTimeoutMs: parseInt(process.env.FORWARD_SERVICE_ACQUIRE_CONNECTION_TIMEOUT_MS || '5000', 10),
		maxRetries: parseInt(process.env.FORWARD_SERVICE_MAX_RETRIES || '3', 10),
	};
}

function getPortMapping(): Record<number, string> {
	// Parse PORT_MAPPING environment variable (format: "port1:val1,port2:val2")
	const portMapping: Record<number, string> = {};
	const mappings = process.env.PORT_MAPPING?.split(',') ?? [];

	for (const mapping of mappings) {
		const [portStr, prefix] = mapping.split(':');
		const port = parseInt(portStr, 10);
		if (!isNaN(port) && prefix) {
			portMapping[port] = prefix.endsWith(':') ? prefix : `${prefix}:`;
		}
	}

	if (Object.keys(portMapping).length === 0) {
		console.log('No valid port mapping found. Using default port with default mapping');
		const defaultListeningPort = parseInt(process.env.DEFAULT_LISTENING_PORT ?? '7000', 10);
		const defaultPortMapping = process.env.DEFAULT_PORT_MAPPING
			? process.env.DEFAULT_PORT_MAPPING.endsWith(':')
				? process.env.DEFAULT_PORT_MAPPING
				: `${process.env.DEFAULT_PORT_MAPPING}:`
			: 'default:';
		portMapping[defaultListeningPort] = defaultPortMapping;
	}

	console.log('Port mapping configured', { portPrefixMap: portMapping });

	return portMapping;
}

function getTlsClientOptions(): TlsServerClientOptions {
	return {
		useTls: process.env.TLS_CLIENT_ENABLED === 'true',
		tlsOptions: {
			certPath: process.env.TLS_CLIENT_CERT_PATH || '',
			keyPath: process.env.TLS_CLIENT_KEY_PATH || '',
			caPath: process.env.TLS_CLIENT_CA_PATH || '',
		},
	};
}

function getTlsServerOptions(): TlsServerClientOptions {
	return {
		useTls: process.env.TLS_SERVER_ENABLED === 'true',
		tlsOptions: {
			certPath: process.env.TLS_SERVER_CERT_PATH || '',
			keyPath: process.env.TLS_SERVER_KEY_PATH || '',
			caPath: process.env.TLS_SERVER_CA_PATH || '',
			requestCert: process.env.TLS_SERVER_REQUEST_CERT === 'true',
			rejectUnauthorized: process.env.TLS_SERVER_REJECT_UNAUTHORIZED === 'true',
		},
	};
}
