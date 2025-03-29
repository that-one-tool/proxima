export type ErrorOptions = { cause?: unknown; context?: Record<string, unknown> };

export class WrappedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, { cause: options?.cause });
	}
}

export class ContextualError extends WrappedError {
	private readonly context: Record<string, unknown> | undefined;

	constructor(message: string, options?: ErrorOptions) {
		super(message, { cause: options?.cause });

		this.context = options?.context;
	}
}

export class ConnectionPoolError extends ContextualError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}
