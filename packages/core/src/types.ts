export type Optional<T> = T | undefined;

/**
 * A per-session, per-direction transform applied to forwarded bytes.
 * Instances may be stateful (e.g. buffering partial RESP frames for reassembly),
 * so each client session gets its own instance via a {@link TransformerFactory}.
 */
export type TransformerFunction = Optional<(data: Buffer, mapping: string) => Buffer>;

/**
 * A mutable, per-client-session scratch bag shared by every transformer instance of that
 * session (both directions). The proxy creates one per accepted connection and hands the same
 * object to each {@link TransformerFactory}, so a request-side transformer can correlate with
 * its response-side sibling (e.g. to know whether a reply carries keys). Keys are namespaced by
 * their owning module; the core treats the contents as opaque.
 */
export type SessionState = Record<string, unknown>;

/**
 * SessionState flag a transformer sets truthy once the session has left connection-scoped state on the
 * pooled socket that must not leak to the next tenant — e.g. `SELECT`, `AUTH`, `HELLO 3`, `SUBSCRIBE`,
 * an open `MULTI`/`WATCH`, or `CLIENT REPLY`/`CLIENT TRACKING`. When set, the proxy destroys the pooled
 * connection on release instead of recycling it, so a sanitized (fresh) connection serves the next
 * client. The core treats the value as opaque apart from this strict-equality check.
 */
export const RECYCLE_UNSAFE_KEY = '__proximaRecycleUnsafe';

/**
 * Produces a fresh {@link TransformerFunction} for a single client session, given that session's
 * shared {@link SessionState}. A factory (rather than a shared function) is required so that any
 * per-session state — such as a RESP reassembly buffer — is isolated between connections and
 * never leaks bytes from one client into another.
 */
export type TransformerFactory = Optional<(session: SessionState) => NonNullable<TransformerFunction>>;

export type TlsServerClientOptions = { useTls?: false; tlsOptions?: TlsOptions } | { useTls: true; tlsOptions: TlsOptions };

export interface TlsOptions {
	certPath: string;
	keyPath: string;
	caPath?: string;
	requestCert?: boolean;
	rejectUnauthorized?: boolean;
}
