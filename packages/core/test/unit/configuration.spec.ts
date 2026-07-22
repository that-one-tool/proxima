import { getConfig } from '../../src/configuration';
import { Logger } from '../../src/logging';

const ORIGINAL_ENV = process.env;

function expectGetConfigToExit(): void {
	const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`process.exit:${code}`);
	}) as never);
	jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

	expect(() => getConfig()).toThrow('process.exit:1');
	expect(exitSpy).toHaveBeenCalledWith(1);
}

describe('getConfig', () => {
	beforeEach(() => {
		process.env = {};
	});

	afterEach(() => {
		process.env = ORIGINAL_ENV;
		jest.restoreAllMocks();
	});

	describe('defaults', () => {
		it('provides sane defaults when the environment is empty', () => {
			const config = getConfig();

			expect(config.trustedHttpPort).toBe(9101);
			expect(config.version).toBe('unknown');
			expect(config.ipBlacklist).toEqual([]);
			expect(config.ipWhitelist).toEqual([]);
			expect(config.portMapping).toEqual({ 7000: 'default:' });
			expect(config.forwardServiceOptions.host).toBe('127.0.0.1');
			expect(config.forwardServiceOptions.port).toBe(6379);
			expect(config.forwardServiceOptions.minPoolConnections).toBe(5);
			expect(config.forwardServiceOptions.maxPoolConnections).toBe(20);
		});

		it('defaults rejectUnauthorized to true (secure-by-default)', () => {
			const config = getConfig();

			expect(config.tlsServerOptions.tlsOptions?.rejectUnauthorized).toBe(true);
			expect(config.tlsClientOptions.tlsOptions?.rejectUnauthorized).toBe(true);
		});

		it('allows rejectUnauthorized to be turned off explicitly', () => {
			process.env.TLS_SERVER_REJECT_UNAUTHORIZED = 'false';

			expect(getConfig().tlsServerOptions.tlsOptions?.rejectUnauthorized).toBe(false);
		});
	});

	describe('boolean parsing (#6)', () => {
		it('reads booleans case-insensitively so TRUE does not silently disable a check', () => {
			process.env.TLS_SERVER_REJECT_UNAUTHORIZED = 'TRUE';

			expect(getConfig().tlsServerOptions.tlsOptions?.rejectUnauthorized).toBe(true);
		});

		it('accepts alternative truthy tokens (Yes / On / 1)', () => {
			process.env.TLS_SERVER_ENABLED = 'Yes';
			process.env.TLS_SERVER_CERT_PATH = '/tmp/cert.pem';
			process.env.TLS_SERVER_KEY_PATH = '/tmp/key.pem';

			expect(getConfig().tlsServerOptions.useTls).toBe(true);
		});

		it('accepts alternative falsey tokens (0 / Off / No)', () => {
			process.env.TLS_SERVER_REJECT_UNAUTHORIZED = '0';

			expect(getConfig().tlsServerOptions.tlsOptions?.rejectUnauthorized).toBe(false);
		});

		it('exits when a boolean env var has an unrecognized value', () => {
			process.env.TLS_SERVER_REJECT_UNAUTHORIZED = 'maybe';

			expectGetConfigToExit();
		});
	});

	describe('list parsing', () => {
		it('turns an empty blacklist into an empty array, not [""]', () => {
			process.env.IP_BLACKLIST = '';

			expect(getConfig().ipBlacklist).toEqual([]);
		});

		it('trims and filters blank entries', () => {
			process.env.IP_WHITELIST = '10.0.0.1, 10.0.0.2 ,';

			expect(getConfig().ipWhitelist).toEqual(['10.0.0.1', '10.0.0.2']);
		});
	});

	describe('port mapping', () => {
		it('keeps everything after the first colon as the prefix', () => {
			process.env.PORT_MAPPING = '8080:api:v2';

			expect(getConfig().portMapping).toEqual({ 8080: 'api:v2:' });
		});

		it('lets a later duplicate port override an earlier one', () => {
			const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
			process.env.PORT_MAPPING = '7000:alpha,7000:beta';

			expect(getConfig().portMapping).toEqual({ 7000: 'beta:' });
			expect(warnSpy).toHaveBeenCalled();
		});

		it('ignores mappings with an out-of-range port', () => {
			process.env.PORT_MAPPING = '70000:api';

			expect(getConfig().portMapping).toEqual({ 7000: 'default:' });
		});
	});

	describe('validation', () => {
		it('exits when a numeric env var is not a number', () => {
			process.env.TRUSTED_HTTP_PORT = 'abc';

			expectGetConfigToExit();
		});

		it('exits when a port is out of range', () => {
			process.env.TRUSTED_HTTP_PORT = '70000';

			expectGetConfigToExit();
		});

		it('exits when min pool connections exceed max', () => {
			process.env.FORWARD_SERVICE_MIN_POOL_CONNECTIONS = '100';
			process.env.FORWARD_SERVICE_MAX_POOL_CONNECTIONS = '20';

			expectGetConfigToExit();
		});

		it('exits when a numeric env var has trailing garbage instead of silently truncating it', () => {
			process.env.TRUSTED_HTTP_PORT = '9101abc';

			expectGetConfigToExit();
		});

		it('exits when TLS is enabled but the certificate path is empty', () => {
			process.env.TLS_SERVER_ENABLED = 'true';
			process.env.TLS_SERVER_KEY_PATH = '/tmp/key.pem';

			expectGetConfigToExit();
		});

		it('exits when TLS is enabled but the key path is empty', () => {
			process.env.TLS_CLIENT_ENABLED = 'true';
			process.env.TLS_CLIENT_CERT_PATH = '/tmp/cert.pem';

			expectGetConfigToExit();
		});
	});
});
