import { Optional } from '../types';

export type ErrorOptions = Optional<{ cause?: unknown; context?: Record<string, unknown> }>;

export class ContextualError extends Error {
	private readonly context: Record<string, unknown>;

	constructor(message: string, options?: ErrorOptions) {
		super(message, { cause: options?.cause });

		this.context = options?.context ?? {};
	}
}

export class ConnectionPoolError extends ContextualError {
	constructor(message: string, options: ErrorOptions) {
		super(message, options);
	}
}
