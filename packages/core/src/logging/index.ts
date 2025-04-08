import winston from 'winston';
import { LoggerOptions } from './types';

export class Logger {
	private static instance: Logger;
	private logger: winston.Logger;

	private constructor(options: LoggerOptions = {}) {
		const transports = new Set(options.transports ?? [new winston.transports.Console()]);

		this.logger = winston.createLogger({
			level: options.level ?? 'info',
			format:
				options.format ??
				winston.format.combine(winston.format.errors({ stack: true }), winston.format.timestamp(), winston.format.json()),
			transports: Array.from(transports),
			silent: options.silent ?? false,
		});
	}

	public static getInstance(options?: LoggerOptions): Logger {
		if (!Logger.instance) {
			Logger.instance = new Logger(options);
		}
		return Logger.instance;
	}

	public static reconfigure(options: LoggerOptions): void {
		if (Logger.instance) {
			Logger.instance = new Logger(options);
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
