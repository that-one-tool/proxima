/// <reference types="jest" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTlsOptions, validateTlsOptions } from '../../src/utils/tls';

describe('tls utils', () => {
	let dir: string;
	let certPath: string;
	let keyPath: string;
	let caPath: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-tls-'));
		certPath = path.join(dir, 'cert.pem');
		keyPath = path.join(dir, 'key.pem');
		caPath = path.join(dir, 'ca.pem');
		fs.writeFileSync(certPath, 'cert-bytes');
		fs.writeFileSync(keyPath, 'key-bytes');
		fs.writeFileSync(caPath, 'ca-bytes');
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('validateTlsOptions', () => {
		it('passes when TLS is disabled', () => {
			expect(() => validateTlsOptions({ useTls: false })).not.toThrow();
		});

		it('throws when cert or key path is missing', () => {
			expect(() => validateTlsOptions({ useTls: true, tlsOptions: { certPath: '', keyPath: '' } })).toThrow();
		});

		it('requires a CA path when requestCert is enabled (mTLS)', () => {
			expect(() =>
				validateTlsOptions({ useTls: true, tlsOptions: { certPath, keyPath, requestCert: true } }),
			).toThrow(/CA path/);
		});

		it('accepts requestCert when a CA path is provided', () => {
			expect(() =>
				validateTlsOptions({ useTls: true, tlsOptions: { certPath, keyPath, caPath, requestCert: true } }),
			).not.toThrow();
		});
	});

	describe('makeTlsOptions', () => {
		it('loads cert, key and CA when all paths exist', () => {
			const options = makeTlsOptions({ certPath, keyPath, caPath });

			expect(options.cert).toBeDefined();
			expect(options.key).toBeDefined();
			expect(Array.isArray(options.ca)).toBe(true);
		});

		it('leaves CA undefined when no caPath is given', () => {
			const options = makeTlsOptions({ certPath, keyPath });

			expect(options.ca).toBeUndefined();
		});

		it('throws when the certificate file is missing', () => {
			expect(() => makeTlsOptions({ certPath: path.join(dir, 'missing.pem'), keyPath })).toThrow();
		});

		it('throws when a caPath is set but the file is missing', () => {
			expect(() => makeTlsOptions({ certPath, keyPath, caPath: path.join(dir, 'no-ca.pem') })).toThrow();
		});
	});
});
