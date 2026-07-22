import winston from 'winston';
import { ContextualError } from '../errors';
import { LoggerOptions } from './types';

/**
 * The codebase logs errors as `{ error: <Error> }` meta. Plain `winston.format.errors` only unwraps
 * an Error passed as the log *message*, so an Error tucked in meta serialized to `{}` (or leaked the
 * private `_context` backing field) — its `.message`/`.stack` never reached the log line. This format
 * lifts a meta `error` into an explicit, JSON-safe object so those fields actually surface.
 */
function serializeError(error: Error): Record<string, unknown> {
	const serialized: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack };
	if (error instanceof ContextualError && error.context !== undefined) {
		serialized.context = error.context;
	}
	if (error.cause !== undefined) {
		serialized.cause = error.cause instanceof Error ? serializeError(error.cause) : error.cause;
	}
	return serialized;
}

const surfaceErrorMeta = winston.format((info) => {
	if (info.error instanceof Error) {
		info.error = serializeError(info.error);
	}
	return info;
});

export class Logger {
	private static instance: Logger;
	private logger: winston.Logger;

	private constructor(options: LoggerOptions = {}) {
		this.logger = winston.createLogger(Logger.buildWinstonOptions(options));
	}

	private static buildWinstonOptions(options: LoggerOptions): winston.LoggerOptions {
		return {
			level: options.level ?? 'info',
			format:
				options.format ??
				winston.format.combine(
					winston.format.errors({ stack: true }),
					surfaceErrorMeta(),
					winston.format.timestamp(),
					winston.format.json(),
				),
			transports: options.transports ?? [new winston.transports.Console()],
			silent: options.silent ?? false,
		};
	}

	public static getInstance(options?: LoggerOptions): Logger {
		if (!Logger.instance) {
			Logger.instance = new Logger(options);
		} else if (options) {
			Logger.instance.logger.warn('Logger already initialized; ignoring options. Use reconfigure() to change the configuration.');
		}
		return Logger.instance;
	}

	public static reconfigure(options: LoggerOptions): void {
		if (Logger.instance) {
			Logger.instance.logger.configure(Logger.buildWinstonOptions(options));
		}
	}

	public error(message: string, meta?: Record<string, unknown>): void {
		this.logger.error(message, meta);
	}

	public warn(message: string, meta?: Record<string, unknown>): void {
		this.logger.warn(message, meta);
	}

	public info(message: string, meta?: Record<string, unknown>): void {
		this.logger.info(message, meta);
	}

	public http(message: string, meta?: Record<string, unknown>): void {
		this.logger.http(message, meta);
	}

	public verbose(message: string, meta?: Record<string, unknown>): void {
		this.logger.verbose(message, meta);
	}

	public debug(message: string, meta?: Record<string, unknown>): void {
		this.logger.debug(message, meta);
	}

	public silly(message: string, meta?: Record<string, unknown>): void {
		this.logger.silly(message, meta);
	}
}
