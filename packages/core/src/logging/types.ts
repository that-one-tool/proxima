import winston from 'winston';

export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly';

export interface LoggerOptions {
	level?: LogLevel;
	transports?: winston.transport[];
	format?: winston.Logform.Format;
	silent?: boolean;
}
