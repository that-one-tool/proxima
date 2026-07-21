import winston from 'winston';
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
});
