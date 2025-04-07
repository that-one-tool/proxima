import { prefixRedisKeys, removePrefixFromRedisResponse } from '../../src/resp-handling';
import { KEY_COMMANDS } from '../../src/resp-constants';

describe('prefixRedisKeys', () => {
	const prefix = 'test:';

	it('should add prefix to keys for GET command', () => {
		// GET key
		const input = Buffer.from('*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n');
		const expected = Buffer.from('*2\r\n$3\r\nGET\r\n$10\r\ntest:mykey\r\n');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('should add prefix to keys for SET command', () => {
		// SET key value
		const input = Buffer.from('*3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$5\r\nvalue\r\n');
		const expected = Buffer.from('*3\r\n$3\r\nSET\r\n$10\r\ntest:mykey\r\n$5\r\nvalue\r\n');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('should not add prefix to keys that already have the prefix', () => {
		const input = Buffer.from('*2\r\n$3\r\nGET\r\n$10\r\ntest:mykey\r\n');
		const expected = Buffer.from('*2\r\n$3\r\nGET\r\n$10\r\ntest:mykey\r\n');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('should not prefix keys for unsupported commands', () => {
		// Create a command not in KEY_COMMANDS
		const nonKeyCommand = 'PING';
		expect(KEY_COMMANDS.includes(nonKeyCommand.toLowerCase())).toBe(false);

		const input = Buffer.from(`*1\r\n$4\r\n${nonKeyCommand}\r\n`);
		const expected = Buffer.from(`*1\r\n$4\r\n${nonKeyCommand}\r\n`);

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('should handle non-RESP protocol data unchanged', () => {
		const input = Buffer.from('plain text data');
		expect(prefixRedisKeys(input, prefix)).toEqual(input);
	});

	it('should handle complex commands with multiple keys', () => {
		// MSET key1 val1 key2 val2
		const input = Buffer.from('*5\r\n$4\r\nMSET\r\n$4\r\nkey1\r\n$4\r\nval1\r\n$4\r\nkey2\r\n$4\r\nval2\r\n');
		const expected = Buffer.from('*5\r\n$4\r\nMSET\r\n$9\r\ntest:key1\r\n$4\r\nval1\r\n$9\r\ntest:key2\r\n$4\r\nval2\r\n');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});
});

describe('removePrefixFromRedisResponse', () => {
	const prefix = 'test:';

	it('should remove prefix from bulk string key response', () => {
		// Bulk string response for a key
		const input = Buffer.from('$10\r\ntest:mykey\r\n');
		const expected = Buffer.from('$5\r\nmykey\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('should not modify bulk string that does not have the prefix', () => {
		const input = Buffer.from('$5\r\nmykey\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});

	it('should handle null bulk string responses', () => {
		const input = Buffer.from('$-1\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});

	it('should remove prefix from each key in an array response', () => {
		// Array of keys like from KEYS command
		const input = Buffer.from('*2\r\n$10\r\ntest:key1\r\n$10\r\ntest:key2\r\n');
		const expected = Buffer.from('*2\r\n$4\r\nkey1\r\n$4\r\nkey2\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('should handle mixed array with prefixed and non-prefixed values', () => {
		const input = Buffer.from('*3\r\n$10\r\ntest:key1\r\n$5\r\nvalue\r\n$10\r\ntest:key2\r\n');
		const expected = Buffer.from('*3\r\n$4\r\nkey1\r\n$5\r\nvalue\r\n$4\r\nkey2\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('should not modify simple string responses', () => {
		// Simple string response (starts with +)
		const input = Buffer.from('+OK\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});

	it('should not modify error responses', () => {
		// Error response (starts with -)
		const input = Buffer.from('-ERR unknown command\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});

	it('should not modify integer responses', () => {
		// Integer response (starts with :)
		const input = Buffer.from(':1000\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});

	it('should handle non-RESP protocol data unchanged', () => {
		const input = Buffer.from('plain text data');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(input);
	});
});
