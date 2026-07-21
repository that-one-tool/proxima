import winston from 'winston';
import { LoggerOptions } from './types';

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
				winston.format.combine(winston.format.errors({ stack: true }), winston.format.timestamp(), winston.format.json()),
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
