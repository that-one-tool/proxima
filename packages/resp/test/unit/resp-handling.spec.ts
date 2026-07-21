import { prefixRedisKeys, removePrefixFromRedisResponse } from '../../src/resp-handling';
import { KEY_COMMANDS } from '../../src/resp-constants';

const CRLF = Buffer.from('\r\n');

function bulk(value: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`$${value.length}\r\n`), value, CRLF]);
}

function command(...args: Array<Buffer | string>): Buffer {
	const buffers = args.map((arg) => (typeof arg === 'string' ? Buffer.from(arg) : arg));
	const parts = [Buffer.from(`*${buffers.length}\r\n`), ...buffers.map(bulk)];
	return Buffer.concat(parts);
}

function respArray(...elements: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from(`*${elements.length}\r\n`), ...elements]);
}

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
		const input = Buffer.from('*2\r\n$9\r\ntest:key1\r\n$9\r\ntest:key2\r\n');
		const expected = Buffer.from('*2\r\n$4\r\nkey1\r\n$4\r\nkey2\r\n');

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('should handle mixed array with prefixed and non-prefixed values', () => {
		const input = Buffer.from('*3\r\n$9\r\ntest:key1\r\n$5\r\nvalue\r\n$9\r\ntest:key2\r\n');
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

describe('binary safety (A4-#1)', () => {
	const prefix = 'test:';
	const binaryValue = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x0d, 0x0a, 0x80, 0xfe]);

	it('round-trips an arbitrary-byte value losslessly while prefixing the key', () => {
		const input = command('SET', 'mykey', binaryValue);
		const expected = command('SET', 'test:mykey', binaryValue);

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes a binary key without corrupting its bytes', () => {
		const binaryKey = Buffer.from([0x01, 0x80, 0xff]);
		const input = command('GET', binaryKey);
		const expected = command('GET', Buffer.concat([Buffer.from(prefix), binaryKey]));

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('strips the prefix from a binary bulk-string response losslessly', () => {
		const input = bulk(Buffer.concat([Buffer.from(prefix), binaryValue]));
		const expected = bulk(binaryValue);

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});
});

describe('binary-safe framing by declared length (A4-#2)', () => {
	const prefix = 'test:';

	it('does not split on CRLF bytes embedded in a bulk-string value', () => {
		const value = Buffer.from('ab\r\ncd');
		const input = command('SET', 'mykey', value);
		const expected = command('SET', 'test:mykey', value);

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('strips a response value that contains CRLF bytes', () => {
		const value = Buffer.from('line1\r\nline2');
		const input = bulk(Buffer.concat([Buffer.from(prefix), value]));
		const expected = bulk(value);

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});
});

describe('array framing and pipelined commands (A4-#3)', () => {
	const prefix = 'test:';

	it('prefixes each of several commands coalesced in one buffer', () => {
		const input = Buffer.concat([command('GET', 'key1'), command('SET', 'key2', 'value')]);
		const expected = Buffer.concat([command('GET', 'test:key1'), command('SET', 'test:key2', 'value')]);

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('stops at the declared element count and leaves trailing bytes intact', () => {
		const input = Buffer.concat([command('GET', 'key1'), command('PING')]);
		const expected = Buffer.concat([command('GET', 'test:key1'), command('PING')]);

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('passes a truncated frame through unchanged', () => {
		const full = command('GET', 'mykey');
		const input = full.subarray(0, full.length - 3);

		expect(prefixRedisKeys(input, prefix)).toEqual(input);
	});
});

describe('null bulk inside an array (A4-#4)', () => {
	const prefix = 'test:';
	const nullBulk = Buffer.from('$-1\r\n');

	it('keeps following elements aligned after a null element in a response', () => {
		const input = respArray(bulk(Buffer.from('test:key1')), nullBulk, bulk(Buffer.from('test:key2')));
		const expected = respArray(bulk(Buffer.from('key1')), nullBulk, bulk(Buffer.from('key2')));

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('handles a trailing null element in a response', () => {
		const input = respArray(bulk(Buffer.from('test:key1')), nullBulk);
		const expected = respArray(bulk(Buffer.from('key1')), nullBulk);

		expect(removePrefixFromRedisResponse(input, prefix)).toEqual(expected);
	});

	it('prefixes every key of an MGET request', () => {
		const input = command('MGET', 'key1', 'key2', 'key3');
		const expected = command('MGET', 'test:key1', 'test:key2', 'test:key3');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});
});

describe('expanded key-command surface (A4-#7)', () => {
	const prefix = 'test:';

	it('prefixes the single key of a SADD command', () => {
		const input = command('SADD', 'myset', 'a', 'b');
		const expected = command('SADD', 'test:myset', 'a', 'b');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the single key of a SETEX command without touching seconds or value', () => {
		const input = command('SETEX', 'mykey', '60', 'value');
		const expected = command('SETEX', 'test:mykey', '60', 'value');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes both keys of a RENAME command', () => {
		const input = command('RENAME', 'src', 'dst');
		const expected = command('RENAME', 'test:src', 'test:dst');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes both keys of a COPY command', () => {
		const input = command('COPY', 'src', 'dst');
		const expected = command('COPY', 'test:src', 'test:dst');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes every argument of an UNLINK command', () => {
		const input = command('UNLINK', 'k1', 'k2', 'k3');
		const expected = command('UNLINK', 'test:k1', 'test:k2', 'test:k3');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes only the key of an HDEL command', () => {
		const input = command('HDEL', 'myhash', 'field1', 'field2');
		const expected = command('HDEL', 'test:myhash', 'field1', 'field2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes only even positions of an MSETNX command', () => {
		const input = command('MSETNX', 'k1', 'v1', 'k2', 'v2');
		const expected = command('MSETNX', 'test:k1', 'v1', 'test:k2', 'v2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});
});

describe('variadic key commands (A4-#7 follow-up)', () => {
	const prefix = 'test:';

	it('prefixes destination and all sources of BITOP, not the operation', () => {
		const input = command('BITOP', 'AND', 'dest', 'src1', 'src2');
		const expected = command('BITOP', 'AND', 'test:dest', 'test:src1', 'test:src2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the keys of BLPOP but not the trailing timeout', () => {
		const input = command('BLPOP', 'k1', 'k2', '5');
		const expected = command('BLPOP', 'test:k1', 'test:k2', '5');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes destination and numkeys-counted keys of ZUNIONSTORE, not the count or options', () => {
		const input = command('ZINTERSTORE', 'dest', '2', 'k1', 'k2', 'WEIGHTS', '1', '2');
		const expected = command('ZINTERSTORE', 'test:dest', '2', 'test:k1', 'test:k2', 'WEIGHTS', '1', '2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes numkeys-counted keys of ZUNION, not the count', () => {
		const input = command('ZUNION', '2', 'k1', 'k2');
		const expected = command('ZUNION', '2', 'test:k1', 'test:k2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes numkeys-counted keys of LMPOP, not the count or direction', () => {
		const input = command('LMPOP', '2', 'k1', 'k2', 'LEFT');
		const expected = command('LMPOP', '2', 'test:k1', 'test:k2', 'LEFT');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the SORT source and STORE destination', () => {
		const input = command('SORT', 'mylist', 'STORE', 'dest');
		const expected = command('SORT', 'test:mylist', 'STORE', 'test:dest');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes only the SORT source when there is no STORE clause', () => {
		const input = command('SORT', 'mylist', 'ALPHA');
		const expected = command('SORT', 'test:mylist', 'ALPHA');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the SORT BY pattern but not the BY keyword', () => {
		const input = command('SORT', 'mylist', 'BY', 'weight_*');
		const expected = command('SORT', 'test:mylist', 'BY', 'test:weight_*');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes SORT GET patterns but leaves the GET # self reference untouched', () => {
		const input = command('SORT', 'mylist', 'GET', '#', 'GET', 'data_*');
		const expected = command('SORT', 'test:mylist', 'GET', '#', 'GET', 'test:data_*');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes every SORT key across BY, GET, LIMIT and STORE clauses', () => {
		const input = command('SORT', 'mylist', 'BY', 'weight_*', 'LIMIT', '0', '10', 'GET', 'object_*', 'GET', '#', 'ALPHA', 'STORE', 'dest');
		const expected = command('SORT', 'test:mylist', 'BY', 'test:weight_*', 'LIMIT', '0', '10', 'GET', 'test:object_*', 'GET', '#', 'ALPHA', 'STORE', 'test:dest');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes both keys of BLMOVE, not the directions or timeout', () => {
		const input = command('BLMOVE', 'src', 'dst', 'LEFT', 'RIGHT', '5');
		const expected = command('BLMOVE', 'test:src', 'test:dst', 'LEFT', 'RIGHT', '5');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the OBJECT ENCODING key but not the subcommand', () => {
		const input = command('OBJECT', 'ENCODING', 'mykey');
		const expected = command('OBJECT', 'ENCODING', 'test:mykey');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('does not prefix a keyless OBJECT subcommand', () => {
		const input = command('OBJECT', 'HELP');

		expect(prefixRedisKeys(input, prefix)).toEqual(input);
	});

	it('prefixes the MEMORY USAGE key but not the subcommand', () => {
		const input = command('MEMORY', 'USAGE', 'mykey');
		const expected = command('MEMORY', 'USAGE', 'test:mykey');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});
});
