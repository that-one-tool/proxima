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
