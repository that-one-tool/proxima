export enum ServerType {
	TCP = 'tcp',
	TLS = 'tls',
}

export interface TlsOptions {
	certPath: string;
	keyPath: string;
	caPath?: string;
	requestCert?: boolean;
	rejectUnauthorized?: boolean;
}

export interface ServerOptions {
	type: ServerType;
	tlsOptions?: TlsOptions;
}
