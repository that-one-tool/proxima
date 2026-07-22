import { Writable } from 'node:stream';
import winston from 'winston';
import { ContextualError } from '../../src/errors';
import { Logger } from '../../src/logging';

type LoggerInternals = { logger: winston.Logger };

function internalWinstonLogger(logger: Logger): winston.Logger {
	return (logger as unknown as LoggerInternals).logger;
}

describe('Logger', () => {
	beforeEach(() => {
		(Logger as unknown as { instance?: Logger }).instance = undefined;
	});

	it('returns a stable singleton', () => {
		expect(Logger.getInstance({ silent: true })).toBe(Logger.getInstance());
	});

	it('ignores options passed to getInstance after initialization and warns', () => {
		const first = Logger.getInstance({ level: 'info', silent: true });
		const warnSpy = jest.spyOn(internalWinstonLogger(first), 'warn').mockImplementation(() => internalWinstonLogger(first));

		const second = Logger.getInstance({ level: 'debug' });

		expect(second).toBe(first);
		expect(internalWinstonLogger(second).level).toBe('info');
		expect(warnSpy).toHaveBeenCalled();
	});

	it('reconfigure mutates an already-held reference instead of swapping the singleton', () => {
		const held = Logger.getInstance({ level: 'info', silent: true });
		const heldWinston = internalWinstonLogger(held);

		Logger.reconfigure({ level: 'silly', silent: true });

		expect(Logger.getInstance()).toBe(held);
		expect(internalWinstonLogger(held)).toBe(heldWinston);
		expect(heldWinston.level).toBe('silly');
	});

	it('delegates level methods to winston with message and meta', () => {
		const logger = Logger.getInstance({ silent: true });
		const infoSpy = jest.spyOn(internalWinstonLogger(logger), 'info').mockImplementation(() => internalWinstonLogger(logger));

		const meta = { requestId: 'abc' };
		logger.info('hello', meta);

		expect(infoSpy).toHaveBeenCalledWith('hello', meta);
	});

	describe('error meta surfacing (#7)', () => {
		function captureLine(log: (logger: Logger) => void): Record<string, unknown> {
			const lines: string[] = [];
			const stream = new Writable({
				write(chunk: Buffer, _encoding, callback): void {
					lines.push(chunk.toString());
					callback();
				},
			});
			// No `format` override, so the default chain (including the error-surfacing format) runs.
			const logger = Logger.getInstance({ transports: [new winston.transports.Stream({ stream })] });
			log(logger);
			return JSON.parse(lines.join('')) as Record<string, unknown>;
		}

		it('surfaces the message and stack of an Error passed in meta.error', () => {
			const parsed = captureLine((logger) => logger.error('failed', { error: new Error('boom') }));

			const error = parsed.error as Record<string, unknown>;
			expect(error.message).toBe('boom');
			expect(error.stack).toContain('boom');
		});

		it('surfaces a ContextualError context without leaking the private _context field', () => {
			const parsed = captureLine((logger) =>
				logger.error('failed', { error: new ContextualError('bad config', { context: { name: 'PORT' } }) }),
			);

			const error = parsed.error as Record<string, unknown>;
			expect(error.message).toBe('bad config');
			expect(error.context).toEqual({ name: 'PORT' });
			expect(error).not.toHaveProperty('_context');
		});
	});
});
