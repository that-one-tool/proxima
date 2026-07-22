import { RECYCLE_UNSAFE_KEY } from '@that-one-tool/proxima-core';
import { createKeyPrefixer, createResponseStripper, prefixRedisKeys, removePrefixFromRedisResponse, SessionTransformer } from '../../src/resp-handling';
import { KEY_COMMANDS } from '../../src/resp-constants';

const CRLF = Buffer.from('\r\n');

/** A request/response transformer pair that shares one per-session correlation context. */
function respSession(): { request: SessionTransformer; response: SessionTransformer } {
	const session: Record<string, unknown> = {};
	return { request: createKeyPrefixer(session), response: createResponseStripper(session) };
}

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

	it('prefixes unconditionally, even a key that already starts with the prefix (no aliasing)', () => {
		// The request side is the sole prefixer: skipping an already-prefixed key would alias the client
		// keys `mykey` and `test:mykey` onto the same physical key. A literal `test:mykey` becomes
		// `test:test:mykey` and round-trips back to `test:mykey` after exactly one strip.
		const input = Buffer.from('*2\r\n$3\r\nGET\r\n$10\r\ntest:mykey\r\n');
		const expected = Buffer.from('*2\r\n$3\r\nGET\r\n$15\r\ntest:test:mykey\r\n');

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

describe('createKeyPrefixer — stream reassembly (findings #1/#2)', () => {
	const prefix = 'test:';

	function feed(transform: SessionTransformer, chunks: Buffer[]): Buffer {
		return Buffer.concat(chunks.map((chunk) => transform(chunk, prefix)));
	}

	it('reassembles a >64KB bulk value split across a TCP boundary and prefixes the key exactly once', () => {
		// A value larger than a socket read forces the frame across chunks — the case that leaked
		// the key UNPREFIXED with the old per-chunk transform (finding #1).
		const value = Buffer.from('x'.repeat(200 * 1024));
		const full = command('SET', 'big', value);
		const split = Math.floor(full.length / 2);
		const { request } = respSession();

		const output = feed(request, [full.subarray(0, split), full.subarray(split)]);

		expect(output).toEqual(command('SET', 'test:big', value));
	});

	it('reassembles a value containing CRLF bytes split mid-value', () => {
		const value = Buffer.from('ab\r\ncd\r\nef');
		const full = command('SET', 'k', value);
		const { request } = respSession();

		// Split inside the value, right after one of the embedded CRLFs, to prove framing is by
		// declared length and not by scanning for CRLF.
		const splitAt = full.indexOf(value) + 4;
		const output = feed(request, [full.subarray(0, splitAt), full.subarray(splitAt)]);

		expect(output).toEqual(command('SET', 'test:k', value));
	});

	it('prefixes every command of a pipeline even when the buffer splits mid-command', () => {
		const full = Buffer.concat([command('GET', 'k1'), command('SET', 'k2', 'v'), command('DEL', 'k3')]);
		const expected = Buffer.concat([command('GET', 'test:k1'), command('SET', 'test:k2', 'v'), command('DEL', 'test:k3')]);
		const { request } = respSession();

		// Split in the middle of the second command so its frame straddles the boundary.
		const splitAt = command('GET', 'k1').length + 6;
		const output = feed(request, [full.subarray(0, splitAt), full.subarray(splitAt)]);

		expect(output).toEqual(expected);
	});

	it('keeps prefixing the command that follows an empty-array (*0) frame (finding #2)', () => {
		const emptyArray = Buffer.from('*0\r\n');
		const input = Buffer.concat([command('SET', 'before', 'a'), emptyArray, command('SET', 'after', 'b')]);
		const expected = Buffer.concat([command('SET', 'test:before', 'a'), emptyArray, command('SET', 'test:after', 'b')]);
		const { request } = respSession();

		expect(request(input, prefix)).toEqual(expected);
	});

	it('keeps prefixing the command that follows a null-array (*-1) frame (finding #2)', () => {
		const nullArray = Buffer.from('*-1\r\n');
		const input = Buffer.concat([command('SET', 'before', 'a'), nullArray, command('GET', 'after')]);
		const expected = Buffer.concat([command('SET', 'test:before', 'a'), nullArray, command('GET', 'test:after')]);
		const { request } = respSession();

		expect(request(input, prefix)).toEqual(expected);
	});

	it('buffers an incomplete trailing frame and prefixes it once the remainder arrives', () => {
		const full = command('GET', 'mykey');
		const { request } = respSession();

		const first = request(full.subarray(0, full.length - 3), prefix);
		const second = request(full.subarray(full.length - 3), prefix);

		expect(first).toEqual(Buffer.alloc(0));
		expect(Buffer.concat([first, second])).toEqual(command('GET', 'test:mykey'));
	});

	it('keeps per-session buffers isolated between two concurrent sessions', () => {
		const full = command('GET', 'shared');
		const split = 8;
		const a = respSession();
		const b = respSession();

		// Interleave two half-delivered frames on separate sessions; neither may absorb the other's bytes.
		a.request(full.subarray(0, split), prefix);
		b.request(full.subarray(0, split), prefix);
		const outA = a.request(full.subarray(split), prefix);
		const outB = b.request(full.subarray(split), prefix);

		expect(outA).toEqual(command('GET', 'test:shared'));
		expect(outB).toEqual(command('GET', 'test:shared'));
	});
});

describe('createResponseStripper — correlated stripping (finding #3)', () => {
	const prefix = 'test:';

	it('does NOT strip a GET value whose bytes start with the tenant prefix', () => {
		// The headline #3 corruption: a stored VALUE that happens to begin with the prefix must
		// round-trip verbatim, because GET is known not to return keys.
		const { request, response } = respSession();
		request(command('GET', 'vp'), prefix);

		const reply = bulk(Buffer.from('test:legit-payload'));

		expect(response(reply, prefix)).toEqual(reply);
	});

	it('does NOT strip MGET values even when a value starts with the prefix', () => {
		const { request, response } = respSession();
		request(command('MGET', 'a', 'b'), prefix);

		const reply = respArray(bulk(Buffer.from('test:v1')), bulk(Buffer.from('plain')));

		expect(response(reply, prefix)).toEqual(reply);
	});

	it('strips the tenant prefix from a KEYS reply', () => {
		const { request, response } = respSession();
		request(command('KEYS', '*'), prefix);

		const reply = respArray(bulk(Buffer.from('test:k1')), bulk(Buffer.from('test:k2')));
		const expected = respArray(bulk(Buffer.from('k1')), bulk(Buffer.from('k2')));

		expect(response(reply, prefix)).toEqual(expected);
	});

	it('does not strip a reply to RANDOMKEY, which is denied and never reaches the service unmodified', () => {
		// RANDOMKEY cannot be scoped to a prefix (it takes no pattern), so it is denied by C1 and draws an
		// error reply. Any bulk that follows must therefore pass through verbatim.
		const { request, response } = respSession();
		request(command('RANDOMKEY'), prefix);

		expect(response(bulk(Buffer.from('test:chosen')), prefix)).toEqual(bulk(Buffer.from('test:chosen')));
	});

	it('strips SCAN result keys but leaves the numeric cursor untouched', () => {
		const { request, response } = respSession();
		request(command('SCAN', '0'), prefix);

		const reply = respArray(bulk(Buffer.from('17')), respArray(bulk(Buffer.from('test:k1')), bulk(Buffer.from('test:k2'))));
		const expected = respArray(bulk(Buffer.from('17')), respArray(bulk(Buffer.from('k1')), bulk(Buffer.from('k2'))));

		expect(response(reply, prefix)).toEqual(expected);
	});

	it('correlates pipelined replies in FIFO order: a value is preserved, the following KEYS is stripped', () => {
		const { request, response } = respSession();
		request(Buffer.concat([command('GET', 'v'), command('KEYS', '*')]), prefix);

		const getReply = bulk(Buffer.from('test:value'));
		const keysReply = respArray(bulk(Buffer.from('test:k1')));
		const expected = Buffer.concat([getReply, respArray(bulk(Buffer.from('k1')))]);

		expect(response(Buffer.concat([getReply, keysReply]), prefix)).toEqual(expected);
	});

	it('reassembles a KEYS reply split across a TCP boundary before stripping', () => {
		const { request, response } = respSession();
		request(command('KEYS', '*'), prefix);

		const reply = respArray(bulk(Buffer.from('test:k1')), bulk(Buffer.from('test:k2')));
		const split = Math.floor(reply.length / 2);
		const output = Buffer.concat([response(reply.subarray(0, split), prefix), response(reply.subarray(split), prefix)]);

		expect(output).toEqual(respArray(bulk(Buffer.from('k1')), bulk(Buffer.from('k2'))));
	});

	it('passes an unexpected reply (empty correlation queue) through unchanged', () => {
		const { response } = respSession();

		const reply = bulk(Buffer.from('test:whatever'));

		expect(response(reply, prefix)).toEqual(reply);
	});

	it('stops stripping once the session subscribes, so a pub/sub message is never rewritten', () => {
		const { request, response } = respSession();
		request(command('SUBSCRIBE', 'ch'), prefix);

		// A pub/sub message push is structurally identical to a KEYS reply; correlation loss must
		// keep it verbatim so a payload starting with the prefix is not corrupted.
		const push = respArray(bulk(Buffer.from('message')), bulk(Buffer.from('ch')), bulk(Buffer.from('test:payload')));

		expect(response(push, prefix)).toEqual(push);
	});

	it('stops stripping after an inline (non-RESP) request breaks correlation', () => {
		const { request, response } = respSession();
		request(Buffer.from('PING\r\n'), prefix);
		request(command('KEYS', '*'), prefix); // would normally queue a strip, but correlation is already lost

		const reply = respArray(bulk(Buffer.from('test:k1')));

		expect(response(reply, prefix)).toEqual(reply);
	});
});

describe('expanded key-command whitelist (finding #5)', () => {
	const prefix = 'test:';

	it('prefixes both the destination and source of ZRANGESTORE', () => {
		const input = command('ZRANGESTORE', 'dest', 'src', '0', '-1');
		const expected = command('ZRANGESTORE', 'test:dest', 'test:src', '0', '-1');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the key of BITFIELD_RO but not its GET arguments', () => {
		const input = command('BITFIELD_RO', 'mykey', 'GET', 'u8', '0');
		const expected = command('BITFIELD_RO', 'test:mykey', 'GET', 'u8', '0');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the key of ZRANDMEMBER', () => {
		const input = command('ZRANDMEMBER', 'myset', '3');
		const expected = command('ZRANDMEMBER', 'test:myset', '3');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes only the stream key of XACK / XCLAIM / XAUTOCLAIM', () => {
		expect(prefixRedisKeys(command('XACK', 's', 'grp', '1-0'), prefix)).toEqual(command('XACK', 'test:s', 'grp', '1-0'));
		expect(prefixRedisKeys(command('XCLAIM', 's', 'grp', 'c', '0', '1-0'), prefix)).toEqual(
			command('XCLAIM', 'test:s', 'grp', 'c', '0', '1-0'),
		);
		expect(prefixRedisKeys(command('XAUTOCLAIM', 's', 'grp', 'c', '0', '0'), prefix)).toEqual(
			command('XAUTOCLAIM', 'test:s', 'grp', 'c', '0', '0'),
		);
	});

	it('prefixes the key of RESTORE and MOVE', () => {
		expect(prefixRedisKeys(command('RESTORE', 'k', '0', 'payload'), prefix)).toEqual(command('RESTORE', 'test:k', '0', 'payload'));
		expect(prefixRedisKeys(command('MOVE', 'k', '1'), prefix)).toEqual(command('MOVE', 'test:k', '1'));
	});

	it('prefixes the GEORADIUS source key and its STORE destination, not the geo args', () => {
		const input = command('GEORADIUS', 'geo', '15', '37', '200', 'km', 'STORE', 'dest');
		const expected = command('GEORADIUS', 'test:geo', '15', '37', '200', 'km', 'STORE', 'test:dest');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the GEORADIUSBYMEMBER key and STOREDIST destination but not the member', () => {
		const input = command('GEORADIUSBYMEMBER', 'geo', 'member', '200', 'km', 'STOREDIST', 'dest');
		const expected = command('GEORADIUSBYMEMBER', 'test:geo', 'member', '200', 'km', 'STOREDIST', 'test:dest');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the stream keys of XREAD but not the COUNT option or the IDs', () => {
		const input = command('XREAD', 'COUNT', '2', 'STREAMS', 's1', 's2', '0', '0');
		const expected = command('XREAD', 'COUNT', '2', 'STREAMS', 'test:s1', 'test:s2', '0', '0');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the stream key of XREADGROUP but not the group, consumer or ID', () => {
		const input = command('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 's1', '>');
		const expected = command('XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'test:s1', '>');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the XGROUP CREATE stream key but not a keyless XGROUP HELP', () => {
		expect(prefixRedisKeys(command('XGROUP', 'CREATE', 'mystream', 'grp', '$'), prefix)).toEqual(
			command('XGROUP', 'CREATE', 'test:mystream', 'grp', '$'),
		);
		expect(prefixRedisKeys(command('XGROUP', 'HELP'), prefix)).toEqual(command('XGROUP', 'HELP'));
	});

	it('prefixes the single key of a MIGRATE, not the host/port/db/timeout', () => {
		const input = command('MIGRATE', '127.0.0.1', '6379', 'mykey', '0', '5000');
		const expected = command('MIGRATE', '127.0.0.1', '6379', 'test:mykey', '0', '5000');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});

	it('prefixes the KEYS clause of a multi-key MIGRATE and leaves the empty key slot untouched', () => {
		const input = command('MIGRATE', '127.0.0.1', '6379', '', '0', '5000', 'KEYS', 'k1', 'k2');
		const expected = command('MIGRATE', '127.0.0.1', '6379', '', '0', '5000', 'KEYS', 'test:k1', 'test:k2');

		expect(prefixRedisKeys(input, prefix)).toEqual(expected);
	});
});

describe('C1 — default-deny isolation and KEYS/SCAN scoping', () => {
	const prefix = 'test:';
	const deniedSentinel = '__proxima_command_denied__';

	function deniedFrame(originalName: string): Buffer {
		return command(deniedSentinel, originalName);
	}

	describe('KEYS / SCAN scoping to the tenant prefix', () => {
		it('scopes a KEYS pattern to the tenant prefix so it cannot enumerate the whole keyspace', () => {
			expect(prefixRedisKeys(command('KEYS', '*'), prefix)).toEqual(command('KEYS', 'test:*'));
			expect(prefixRedisKeys(command('KEYS', 'user:*'), prefix)).toEqual(command('KEYS', 'test:user:*'));
		});

		it('strips the prefix from a scoped KEYS reply', () => {
			const { request, response } = respSession();
			request(command('KEYS', '*'), prefix);

			const reply = respArray(bulk(Buffer.from('test:k1')), bulk(Buffer.from('test:k2')));
			expect(response(reply, prefix)).toEqual(respArray(bulk(Buffer.from('k1')), bulk(Buffer.from('k2'))));
		});

		it('prefixes an existing SCAN MATCH pattern', () => {
			const input = command('SCAN', '0', 'MATCH', 'user:*', 'COUNT', '100');
			const expected = command('SCAN', '0', 'MATCH', 'test:user:*', 'COUNT', '100');

			expect(prefixRedisKeys(input, prefix)).toEqual(expected);
		});

		it('injects a MATCH clause scoped to the prefix when SCAN has none', () => {
			expect(prefixRedisKeys(command('SCAN', '0'), prefix)).toEqual(command('SCAN', '0', 'MATCH', 'test:*'));
			expect(prefixRedisKeys(command('SCAN', '0', 'COUNT', '10'), prefix)).toEqual(
				command('SCAN', '0', 'COUNT', '10', 'MATCH', 'test:*'),
			);
		});

		it('strips the keys of a scoped SCAN reply but leaves the cursor', () => {
			const { request, response } = respSession();
			request(command('SCAN', '0'), prefix);

			const reply = respArray(bulk(Buffer.from('42')), respArray(bulk(Buffer.from('test:k1'))));
			expect(response(reply, prefix)).toEqual(respArray(bulk(Buffer.from('42')), respArray(bulk(Buffer.from('k1')))));
		});
	});

	describe('denial of commands that cannot be safely prefixed', () => {
		it('denies RANDOMKEY (cannot be scoped)', () => {
			expect(prefixRedisKeys(command('RANDOMKEY'), prefix)).toEqual(deniedFrame('RANDOMKEY'));
		});

		it('denies destructive / global admin commands', () => {
			for (const name of ['FLUSHALL', 'FLUSHDB', 'SWAPDB', 'SHUTDOWN', 'CONFIG', 'DEBUG', 'MONITOR', 'REPLICAOF']) {
				expect(prefixRedisKeys(command(name), prefix)).toEqual(deniedFrame(name));
			}
		});

		it('denies cross-tenant read primitives that are not in the key table (SUBSTR, EVAL)', () => {
			expect(prefixRedisKeys(command('SUBSTR', 'other:secret', '0', '-1'), prefix)).toEqual(deniedFrame('SUBSTR'));
			expect(prefixRedisKeys(command('EVAL', "return redis.call('get', KEYS[1])", '1', 'other:secret'), prefix)).toEqual(
				deniedFrame('EVAL'),
			);
		});

		it('denies an unknown command by default (default-deny), preserving its name for the error', () => {
			expect(prefixRedisKeys(command('TOTALLYMADEUP', 'x'), prefix)).toEqual(deniedFrame('TOTALLYMADEUP'));
		});

		it('records exactly one non-stripping reply expectation for a denied command', () => {
			const { request, response } = respSession();
			request(command('FLUSHALL'), prefix);

			// The denied command draws one error reply; a value that follows must not be stripped.
			const errorReply = Buffer.from("-ERR unknown command '__proxima_command_denied__'\r\n");
			expect(response(errorReply, prefix)).toEqual(errorReply);
		});
	});

	describe('safe passthrough commands', () => {
		it('forwards keyless connection/transaction commands unchanged', () => {
			for (const cmd of [command('PING'), command('HELLO', '2'), command('MULTI'), command('EXEC'), command('INFO')]) {
				expect(prefixRedisKeys(cmd, prefix)).toEqual(cmd);
			}
		});
	});

	describe('inline (non-RESP) requests are denied, not forwarded unprefixed', () => {
		it('replaces inline bytes with a denial frame so they never reach the service', () => {
			const { request } = respSession();
			// A malicious client could otherwise bypass prefixing with inline `GET other:secret\r\n`.
			expect(request(Buffer.from('GET other:secret\r\n'), prefix)).toEqual(command('__proxima_command_denied__', 'inline'));
		});
	});
});

describe('H2 — RESP3 aggregate replies do not desync correlation', () => {
	const prefix = 'test:';

	it('stops correlating once the client negotiates HELLO 3, so a later SCAN reply is left verbatim (no corruption)', () => {
		const { request, response } = respSession();
		request(Buffer.concat([command('HELLO', '3'), command('SCAN', '0')]), prefix);

		const helloMap = Buffer.concat([Buffer.from('%1\r\n'), bulk(Buffer.from('proto')), Buffer.from(':3\r\n')]);
		const scanReply = respArray(bulk(Buffer.from('0')), respArray(bulk(Buffer.from('test:k1'))));
		const input = Buffer.concat([helloMap, scanReply]);

		// Fail-safe: correlation is dropped at HELLO 3, so everything passes through untouched — crucially
		// no value bulk inside the RESP3 map is ever mis-stripped.
		expect(response(input, prefix)).toEqual(input);
	});

	it('drops correlation if a RESP3 aggregate reply appears without a prior HELLO 3', () => {
		const { request, response } = respSession();
		request(command('GET', 'k'), prefix);

		// A push/map arriving where the flat scanner expects a RESP2 reply must not be mis-framed.
		const push = Buffer.concat([Buffer.from('>2\r\n'), bulk(Buffer.from('message')), bulk(Buffer.from('test:payload'))]);
		expect(response(push, prefix)).toEqual(push);
	});
});

describe('connection-state recycling safety (destroy-on-dirty)', () => {
	const prefix = 'test:';

	/** Run a sequence of commands through a fresh request transformer and report the recycle-unsafe flag. */
	function isDirtyAfter(commands: Buffer[]): boolean {
		const session: Record<string, unknown> = {};
		const request = createKeyPrefixer(session);
		for (const cmd of commands) {
			request(cmd, prefix);
		}
		return session[RECYCLE_UNSAFE_KEY] === true;
	}

	it('a plain key-command session stays recyclable', () => {
		expect(isDirtyAfter([command('SET', 'k', 'v'), command('GET', 'k'), command('KEYS', '*')])).toBe(false);
	});

	it('SELECT to a non-zero DB marks the session unsafe, but SELECT 0 does not', () => {
		expect(isDirtyAfter([command('SELECT', '5')])).toBe(true);
		expect(isDirtyAfter([command('SELECT', '0')])).toBe(false);
	});

	it('AUTH marks the session unsafe', () => {
		expect(isDirtyAfter([command('AUTH', 'user', 'pass')])).toBe(true);
	});

	it('HELLO 3 marks the session unsafe, HELLO 2 does not', () => {
		expect(isDirtyAfter([command('HELLO', '3')])).toBe(true);
		expect(isDirtyAfter([command('HELLO', '2')])).toBe(false);
	});

	it('SUBSCRIBE marks the session unsafe', () => {
		expect(isDirtyAfter([command('SUBSCRIBE', 'ch')])).toBe(true);
	});

	it('CLIENT REPLY / TRACKING mark the session unsafe, CLIENT SETNAME stays recyclable', () => {
		expect(isDirtyAfter([command('CLIENT', 'REPLY', 'OFF')])).toBe(true);
		expect(isDirtyAfter([command('CLIENT', 'TRACKING', 'ON')])).toBe(true);
		expect(isDirtyAfter([command('CLIENT', 'SETNAME', 'app')])).toBe(false);
	});

	it('a balanced MULTI/EXEC stays recyclable, but an open MULTI does not', () => {
		expect(isDirtyAfter([command('MULTI'), command('SET', 'k', 'v'), command('EXEC')])).toBe(false);
		expect(isDirtyAfter([command('MULTI'), command('DISCARD')])).toBe(false);
		expect(isDirtyAfter([command('MULTI'), command('SET', 'k', 'v')])).toBe(true);
	});

	it('a dangling WATCH marks the session unsafe; UNWATCH or EXEC clears it', () => {
		expect(isDirtyAfter([command('WATCH', 'k')])).toBe(true);
		expect(isDirtyAfter([command('WATCH', 'k'), command('UNWATCH')])).toBe(false);
		expect(isDirtyAfter([command('WATCH', 'k'), command('MULTI'), command('EXEC')])).toBe(false);
	});

	it('RESET clears prior dirty state', () => {
		expect(isDirtyAfter([command('SELECT', '5'), command('RESET')])).toBe(false);
	});

	it('a denied command does not dirty the session (it never executes)', () => {
		expect(isDirtyAfter([command('FLUSHALL')])).toBe(false);
	});
});
