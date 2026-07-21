export type Optional<T> = T | undefined;
export type TransformerFunction = Optional<(data: Buffer, mapping: string) => Buffer>;

export type TlsServerClientOptions = { useTls?: false; tlsOptions?: TlsOptions } | { useTls: true; tlsOptions: TlsOptions };

export interface TlsOptions {
	certPath: string;
	keyPath: string;
	caPath?: string;
	requestCert?: boolean;
	rejectUnauthorized?: boolean;
}
