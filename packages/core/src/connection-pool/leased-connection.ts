import type { ConnectionStatus, PoolConnection } from './types';

type SocketEvent = 'data' | 'close' | 'error';

/**
 * A lease-scoped view over a pooled socket.
 *
 * Consumers attach their per-session listeners through this wrapper instead of
 * touching the raw {@link net.Socket}. The pool records every listener the lease
 * registers and strips exactly those on release (via {@link detach}), so a pooled
 * socket always returns to the pool clean — no consumer has to remember to
 * `.off()` its own handlers. This is what makes the cross-client listener leak
 * (accumulating `data`/`close`/`error` handlers across reuses) structurally
 * impossible rather than merely neutralized by convention.
 */
export class LeasedConnection {
	private readonly registered: Array<{ event: SocketEvent; handler: (...args: never[]) => void }> = [];
	private isDetached = false;

	constructor(private readonly connection: PoolConnection) {}

	get id(): string {
		return this.connection.id;
	}

	get leaseId(): number {
		return this.connection.leaseId;
	}

	get status(): ConnectionStatus {
		return this.connection.status;
	}

	on(event: 'data', handler: (data: Buffer) => void): this;
	on(event: 'close', handler: (hadError: boolean) => void): this;
	on(event: 'error', handler: (err: Error) => void): this;
	on(event: SocketEvent, handler: (...args: never[]) => void): this {
		this.connection.socket.on(event, handler as (...args: unknown[]) => void);
		this.registered.push({ event, handler });
		return this;
	}

	write(data: Buffer): boolean {
		return this.connection.socket.write(data);
	}

	/**
	 * Remove every listener attached during this lease, leaving the underlying
	 * socket carrying only the pool's own lifecycle handlers. Idempotent.
	 */
	detach(): void {
		if (this.isDetached) {
			return;
		}

		this.isDetached = true;
		for (const { event, handler } of this.registered) {
			this.connection.socket.off(event, handler as (...args: unknown[]) => void);
		}

		this.registered.length = 0;
	}
}
