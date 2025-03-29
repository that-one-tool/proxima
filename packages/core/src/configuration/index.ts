export interface Config {
	forwardHost: string;
	forwardPort: number;
	forwardServiceName: string;
	ipBlacklist: string[];
	ipWhitelist: string[];
	portMapping: Record<number, string>;
	trustedPort: number;
	version: string;
}

export function getConfig(): Config {
	try {
		const forwardHost = process.env.FORWARD_HOST || '127.0.0.1';
		const forwardPort = parseInt(process.env.FORWARD_PORT ?? '6379', 10);
		const forwardServiceName = process.env.FORWARD_SERVICE_NAME ?? 'Unknown';
		const defaultListeningPort = parseInt(process.env.DEFAULT_LISTENING_PORT ?? '6380', 10);
		const defaultPortMapping = process.env.DEFAULT_PORT_MAPPING
			? process.env.DEFAULT_PORT_MAPPING.endsWith(':')
				? process.env.DEFAULT_PORT_MAPPING
				: `${process.env.DEFAULT_PORT_MAPPING}:`
			: 'default:';
		const trustedPort = parseInt(process.env.TRUSTED_PORT ?? '9101', 10);
		const version = process.env.VERSION ?? 'unknown';
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
			console.log('No valid port-prefix mappings found. Using default port with prefix default prefix');
			portMapping[defaultListeningPort] = defaultPortMapping;
		}

		console.log('Link port -> prefix configured', { portPrefixMap: portMapping });

		const ipBlacklist = process.env.IP_BLACKLIST?.split(',') ?? [];
		const ipWhitelist = process.env.IP_WHITELIST?.split(',') ?? [];

		return {
			forwardHost,
			forwardPort,
			forwardServiceName,
			ipBlacklist,
			ipWhitelist,
			portMapping,
			trustedPort,
			version,
		};
	} catch (error) {
		console.error('Error parsing environment variables', error);
		process.exit(1);
	}
}
