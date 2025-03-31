export type Optional<T> = T | undefined;
export type TransformerFunction = Optional<(data: Buffer, mapping: string) => Buffer>;

export interface TlsServerClientOptions {
	useTls?: boolean;
	tlsOptions?: TlsOptions;
}

export interface TlsOptions {
	certPath: string;
	keyPath: string;
	caPath?: string;
	requestCert?: boolean;
	rejectUnauthorized?: boolean;
}
