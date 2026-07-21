import { ConnectionPoolError, ContextualError, WrappedError } from '../../src/errors';

describe('WrappedError', () => {
	it('preserves the cause', () => {
		const cause = new Error('root');
		const error = new WrappedError('wrapped', { cause });

		expect(error.cause).toBe(cause);
	});

	it('sets name to the class name', () => {
		expect(new WrappedError('boom').name).toBe('WrappedError');
	});

	it('is an instance of Error', () => {
		expect(new WrappedError('boom')).toBeInstanceOf(Error);
	});

	it('produces a stack without the wrapper constructor frame', () => {
		const error = new WrappedError('boom');

		expect(typeof error.stack).toBe('string');
		expect(error.stack).not.toMatch(/at new WrappedError/);
	});
});

describe('ContextualError', () => {
	it('exposes context through a getter', () => {
		const context = { port: 6379 };
		const error = new ContextualError('bad', { context });

		expect(error.context).toEqual(context);
	});

	it('preserves the cause and sets its name', () => {
		const cause = new Error('root');
		const error = new ContextualError('bad', { cause });

		expect(error.cause).toBe(cause);
		expect(error.name).toBe('ContextualError');
	});

	it('keeps the instanceof chain', () => {
		const error = new ContextualError('bad');

		expect(error).toBeInstanceOf(WrappedError);
		expect(error).toBeInstanceOf(Error);
	});
});

describe('ConnectionPoolError', () => {
	it('sets name and retains context', () => {
		const context = { host: 'localhost' };
		const error = new ConnectionPoolError('pool', { context });

		expect(error.name).toBe('ConnectionPoolError');
		expect(error.context).toEqual(context);
	});

	it('keeps the full instanceof chain', () => {
		const error = new ConnectionPoolError('pool');

		expect(error).toBeInstanceOf(ContextualError);
		expect(error).toBeInstanceOf(WrappedError);
		expect(error).toBeInstanceOf(Error);
	});
});
