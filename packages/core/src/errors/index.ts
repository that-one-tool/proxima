export type ErrorOptions = { cause?: unknown; context?: Record<string, unknown> };

export class WrappedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, { cause: options?.cause });
		this.name = this.constructor.name;
		Error.captureStackTrace(this, this.constructor);
	}
}

export class ContextualError extends WrappedError {
	private readonly _context: Record<string, unknown> | undefined;

	constructor(message: string, options?: ErrorOptions) {
		super(message, { cause: options?.cause });
		this._context = options?.context;
	}

	public get context(): Record<string, unknown> | undefined {
		return this._context;
	}
}

export class ConnectionPoolError extends ContextualError {}
