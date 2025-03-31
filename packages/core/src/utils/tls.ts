import fs from 'node:fs';
import tls from 'node:tls';
import { ContextualError } from '../errors';
import { TlsOptions, TlsServerClientOptions } from '../types';

export function makeTlsOptions(options: TlsOptions): tls.ConnectionOptions {
	try {
		if (!fs.existsSync(options.certPath)) {
			throw new ContextualError('Certificate file not found', { context: { path: options.certPath } });
		}

		if (!fs.existsSync(options.keyPath)) {
			throw new ContextualError('Private key file not found', { context: { path: options.keyPath } });
		}

		const cert = fs.readFileSync(options.certPath);
		const key = fs.readFileSync(options.keyPath);

		let ca: Buffer | undefined;
		if (options.caPath && fs.existsSync(options.caPath)) {
			ca = fs.readFileSync(options.caPath);
		}

		return {
			cert,
			key,
			ca: ca ? [ca] : undefined,
		};
	} catch (error) {
		throw new ContextualError('Failed to create TLS options', { cause: error });
	}
}

export function validateOptions(options: TlsServerClientOptions): void {
	if (options.useTls) {
		const hasCertPath = options.tlsOptions?.certPath;
		const hasKeyPath = options.tlsOptions?.keyPath;

		if (!hasCertPath || !hasKeyPath) {
			throw new ContextualError('Cert path and Key path environment variables must be set to use TLS');
		}
	}
}
