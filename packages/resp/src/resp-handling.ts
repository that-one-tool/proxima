import type { SessionState } from '@that-one-tool/proxima-core';
import { KEY_POSITIONS, KEY_RESOLVERS, KeyPattern, RESP, RESP_SPLIT, RESP_U8, VariadicSpec } from './resp-constants';

const CRLF = Buffer.from(RESP_SPLIT, 'latin1');
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Commands whose reply *is* (or contains) keys, so the tenant prefix must be stripped on the way
 * back to the client. Every other command returns values / members / metadata, which must pass
 * through untouched — stripping them is the over-stripping corruption bug (finding #3).
 *   - `keys`      → a flat array of matching keys
 *   - `randomkey` → a single bulk key (or a null bulk)
 *   - `scan`      → `[cursor, [keys…]]`; the numeric cursor never matches the prefix, so a blind
 *                   strip of the reply only rewrites the key elements
 */
const KEY_RETURNING_COMMANDS = new Set(['keys', 'randomkey', 'scan']);

/**
 * Once a session issues one of these, the server may emit *unsolicited* frames (pub/sub messages),
 * so request→reply order can no longer be trusted for correlation. Stripping is disabled for the
 * rest of the session (fail-safe: the prefix may show through on a `KEYS`, but no value is ever
 * corrupted).
 */
const CORRELATION_BREAKING_COMMANDS = new Set(['subscribe', 'psubscribe', 'ssubscribe']);

const RESP_SESSION_KEY = '__respSession';

/**
 * Per-session correlation state shared by the request-side prefixer and the response-side stripper
 * of the same connection. It lets the stripper rewrite *only* replies to key-returning commands.
 */
interface RespSessionContext {
	/** FIFO of awaited replies: `true` when the reply carries keys that must be un-prefixed. */
	pending: boolean[];
	/** Set once request→reply order can no longer be trusted; the stripper then passes everything through. */
	correlationLost: boolean;
}

function getRespContext(session: SessionState): RespSessionContext {
	const existing = session[RESP_SESSION_KEY] as RespSessionContext | undefined;
	if (existing) {
		return existing;
	}
	const created: RespSessionContext = { pending: [], correlationLost: false };
	session[RESP_SESSION_KEY] = created;
	return created;
}

/** Permanently stop correlating for this session and drop any queued expectations. */
function loseCorrelation(context: RespSessionContext): void {
	context.correlationLost = true;
	context.pending.length = 0;
}

/** Queue one reply-expectation per issued command; a subscribe (or lost correlation) disables stripping. */
function recordCommands(context: RespSessionContext, commands: (string | null)[]): void {
	if (context.correlationLost) {
		return;
	}
	for (const command of commands) {
		if (command === null) {
			// Empty (`*0`) / null (`*-1`) arrays are ignored by Redis and draw no reply — nothing to await.
			continue;
		}
		if (CORRELATION_BREAKING_COMMANDS.has(command)) {
			loseCorrelation(context);
			return;
		}
		context.pending.push(KEY_RETURNING_COMMANDS.has(command));
	}
}

/** Consume the expectation for one fully-received reply; only key-returning replies get stripped. */
function shouldStripReply(context: RespSessionContext): boolean {
	if (context.correlationLost || context.pending.length === 0) {
		return false;
	}
	return context.pending.shift() ?? false;
}

/**
 * Upper bound on bytes buffered per session while a RESP frame is still incomplete.
 * Matches Redis' default `proto-max-bulk-len` (512 MB) so a legitimately maximal bulk
 * still reassembles; a frame that never completes past this is flushed raw as a
 * fail-safe (degrading to the pre-reassembly behaviour) instead of growing without bound.
 */
const MAX_PENDING_BYTES = 512 * 1024 * 1024;

const PATTERN_MATCHERS: Record<'even' | 'all', (argIndex: number) => boolean> = {
	all: () => true,
	even: (argIndex) => argIndex % 2 === 0,
};

interface BulkToken {
	start: number;
	valueStart: number;
	valueEnd: number;
	next: number;
	isNull: boolean;
}

interface ArrayHeader {
	start: number;
	count: number;
	next: number;
}

/** Result of scanning a buffer for whole frames: the rebuilt bytes plus how many input bytes were consumed. */
interface WalkResult {
	output: Buffer;
	consumed: number;
}

/**
 * Request-side walk result. Extends {@link WalkResult} with the correlation signal:
 * `commands` lists one lowercased command name per consumed complete command frame (`null` for an
 * empty/null array, which draws no reply), and `inline` marks that the walk stopped at non-RESP
 * bytes it could not frame.
 */
interface PrefixWalkResult extends WalkResult {
	commands: (string | null)[];
	inline: boolean;
}

/** A complete command frame: its rebuilt bytes, the offset just past it, and its command name (`null` for `*0`/`*-1`). */
interface CommandFrame {
	bytes: Buffer;
	next: number;
	command: string | null;
}

/** A stateful, per-session transform over one direction of a proxied connection. */
export type SessionTransformer = (data: Buffer, mapping: string) => Buffer;

/**
 * Prefixes the key arguments of every RESP command frame in the buffer.
 * The buffer may hold several coalesced commands; each is parsed by its declared
 * `*N` element count and `$<len>` byte lengths, so binary-safe values round-trip losslessly.
 *
 * This is the stateless view: an incomplete trailing frame is forwarded verbatim.
 * For live socket traffic use {@link createKeyPrefixer}, which reassembles frames
 * split across TCP reads instead of forwarding their unprefixed remainder.
 */
export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	if (!data.length || !keyPrefix || data[0] !== RESP_U8.ARRAY) {
		return data;
	}

	const prefix = Buffer.from(keyPrefix, 'latin1');
	const { output, consumed } = prefixCompleteCommands(data, prefix);
	return appendUnconsumed(output, data, consumed);
}

/**
 * Removes the prefix from every key value in a RESP response, parsing frames by
 * their declared byte lengths so binary values and null bulks stay aligned.
 *
 * Stateless view: an incomplete trailing reply is forwarded verbatim. For live
 * socket traffic use {@link createResponseStripper}, which reassembles fragmented replies.
 */
export function removePrefixFromRedisResponse(data: Buffer, keyPrefix: string): Buffer {
	if (shouldSkipStrip(data, keyPrefix)) {
		return data;
	}

	const prefix = Buffer.from(keyPrefix, 'latin1');
	const { output, consumed } = stripCompleteValues(data, prefix);
	return appendUnconsumed(output, data, consumed);
}

/**
 * Builds a stateful request-side transformer that prefixes keys across an arbitrary
 * TCP stream. It buffers any incomplete trailing command frame and reassembles it
 * with the next chunk, so fragmented or pipelined traffic never has its keys
 * forwarded unprefixed (fixes the tenant-isolation break on ordinary large/split traffic).
 * A fresh instance must be created per session so buffers never leak between clients.
 */
export function createKeyPrefixer(session: SessionState): SessionTransformer {
	let pending: Buffer = EMPTY_BUFFER;
	const context = getRespContext(session);

	return (data: Buffer, mapping: string): Buffer => {
		if (!mapping) {
			return data;
		}

		const buffer = pending.length ? Buffer.concat([pending, data]) : data;
		if (!buffer.length) {
			pending = EMPTY_BUFFER;
			return buffer;
		}
		if (buffer[0] !== RESP_U8.ARRAY) {
			// Inline / non-RESP request bytes: we can no longer track command boundaries, so
			// request→reply correlation is broken for the rest of the session (fail-safe: no stripping).
			loseCorrelation(context);
			pending = EMPTY_BUFFER;
			return buffer;
		}

		const prefix = Buffer.from(mapping, 'latin1');
		const { output, consumed, commands, inline } = prefixCompleteCommands(buffer, prefix);
		recordCommands(context, commands);
		if (inline) {
			loseCorrelation(context);
		}
		return commit(buffer, output, consumed, (tail) => (pending = tail));
	};
}

/**
 * Builds a stateful response-side transformer. It reassembles fragmented replies before
 * stripping so a reply split across TCP reads is framed correctly rather than partially
 * mis-processed, and — crucially — it only un-prefixes replies to key-returning commands
 * (`KEYS`/`SCAN`/`RANDOMKEY`), correlated through the shared {@link SessionState} with the
 * request-side prefixer. This fixes the over-stripping corruption (finding #3): a stored
 * *value* whose bytes happen to begin with the tenant prefix is returned verbatim, because
 * the command that produced it (`GET`, `MGET`, …) is known not to return keys.
 *
 * Correlation is fail-safe toward *not* stripping: if request→reply order can't be trusted
 * (an inline request, a pub/sub subscribe, or an unexpected extra reply), the stripper passes
 * everything through — the prefix may show through on a `KEYS`, but no value is ever corrupted.
 * A fresh instance must be created per session, sharing one {@link SessionState} with its
 * request-side sibling.
 */
export function createResponseStripper(session: SessionState): SessionTransformer {
	let pending: Buffer = EMPTY_BUFFER;
	const context = getRespContext(session);

	return (data: Buffer, mapping: string): Buffer => {
		if (!mapping) {
			return data;
		}

		const buffer = pending.length ? Buffer.concat([pending, data]) : data;
		if (!buffer.length) {
			pending = EMPTY_BUFFER;
			return buffer;
		}

		const prefix = Buffer.from(mapping, 'latin1');
		const { output, consumed } = stripCorrelatedReplies(buffer, prefix, context);
		return commit(buffer, output, consumed, (tail) => (pending = tail));
	};
}

/**
 * Walks each fully-received top-level reply at the front of `buffer`. A reply is framed by its
 * declared lengths (binary-safe) and only rewritten when its correlated command returns keys;
 * otherwise its exact bytes are forwarded. An incomplete trailing reply is left unconsumed so it
 * can be reassembled with the next chunk. Exactly one correlation expectation is consumed per
 * complete reply, keeping the request/reply queue aligned.
 */
function stripCorrelatedReplies(data: Buffer, prefix: Buffer, context: RespSessionContext): WalkResult {
	const output: Buffer[] = [];
	let offset = 0;

	while (offset < data.length) {
		const stripped: Buffer[] = [];
		const next = stripValue(data, offset, prefix, stripped);
		if (next === null) {
			break;
		}
		// The reply is complete: consume its expectation and choose stripped vs. verbatim bytes.
		output.push(shouldStripReply(context) ? concatOrEmpty(stripped) : data.subarray(offset, next));
		offset = next;
	}

	return { output: concatOrEmpty(output), consumed: offset };
}

/**
 * Emits the fully-parsed prefix of `buffer` and hands the incomplete remainder to
 * `retain` so it can be reassembled with the next chunk. A remainder larger than
 * {@link MAX_PENDING_BYTES} is flushed raw (fail-safe) rather than buffered forever.
 */
function commit(buffer: Buffer, output: Buffer, consumed: number, retain: (tail: Buffer) => void): Buffer {
	const tailLength = buffer.length - consumed;
	if (tailLength > MAX_PENDING_BYTES) {
		retain(EMPTY_BUFFER);
		return appendUnconsumed(output, buffer, consumed);
	}
	// Copy the small remainder so the (possibly large) concatenated buffer can be GC'd.
	retain(tailLength ? Buffer.from(buffer.subarray(consumed)) : EMPTY_BUFFER);
	return output;
}

function appendUnconsumed(output: Buffer, data: Buffer, consumed: number): Buffer {
	if (consumed >= data.length) {
		return output;
	}
	const tail = data.subarray(consumed);
	return output.length ? Buffer.concat([output, tail]) : tail;
}

function shouldSkipStrip(data: Buffer, keyPrefix: string): boolean {
	return !data.length || !keyPrefix || !isStrippableResponse(data[0]);
}

function isStrippableResponse(firstByte: number): boolean {
	return firstByte === RESP_U8.BULK || firstByte === RESP_U8.ARRAY;
}

/**
 * Prefixes every complete command frame at the front of `data`, returning the rebuilt
 * bytes and the number of input bytes consumed. Behaviour on non-complete input:
 *   - an incomplete trailing frame (declared bytes not all arrived) is left unconsumed;
 *   - an empty (`*0`) or null (`*-1`) array is a complete frame — forwarded verbatim and
 *     scanning continues (so a later pipelined command is still prefixed);
 *   - non-RESP / inline bytes at a frame boundary cannot be reframed and are handed back verbatim.
 */
function prefixCompleteCommands(data: Buffer, prefix: Buffer): PrefixWalkResult {
	const output: Buffer[] = [];
	const commands: (string | null)[] = [];
	let offset = 0;
	let inline = false;

	while (offset < data.length) {
		if (data[offset] !== RESP_U8.ARRAY) {
			output.push(data.subarray(offset));
			offset = data.length;
			inline = true;
			break;
		}

		const frame = takeCommandFrame(data, offset, prefix);
		if (frame === null) {
			break;
		}

		output.push(frame.bytes);
		commands.push(frame.command);
		offset = frame.next;
	}

	return { output: concatOrEmpty(output), consumed: offset, commands, inline };
}

function takeCommandFrame(data: Buffer, offset: number, prefix: Buffer): CommandFrame | null {
	const header = readArrayHeader(data, offset);
	if (!header) {
		return null;
	}
	if (header.count <= 0) {
		return { bytes: data.subarray(offset, header.next), next: header.next, command: null };
	}

	const elements = readBulkElements(data, header.next, header.count);
	if (!elements) {
		return null;
	}

	return {
		bytes: buildPrefixedCommand(data, offset, elements, prefix),
		next: elements[elements.length - 1].next,
		command: bulkValueAsString(data, elements[0]),
	};
}

function readBulkElements(data: Buffer, offset: number, count: number): BulkToken[] | null {
	const elements: BulkToken[] = [];
	let cursor = offset;
	for (let index = 0; index < count; index++) {
		const token = readBulk(data, cursor);
		if (!token) {
			return null;
		}
		elements.push(token);
		cursor = token.next;
	}
	return elements;
}

function buildPrefixedCommand(data: Buffer, offset: number, elements: BulkToken[], prefix: Buffer): Buffer {
	const chunks: Buffer[] = [data.subarray(offset, elements[0].start), rawBulk(data, elements[0])];
	const keyArgs = keyArgumentIndices(data, elements);
	for (let argIndex = 0; argIndex < elements.length - 1; argIndex++) {
		chunks.push(maybePrefix(data, elements[argIndex + 1], keyArgs.has(argIndex), prefix));
	}
	return Buffer.concat(chunks);
}

function maybePrefix(data: Buffer, token: BulkToken, isKey: boolean, prefix: Buffer): Buffer {
	if (!isKey || token.isNull || startsWithPrefix(data, token, prefix)) {
		return rawBulk(data, token);
	}
	return prefixedBulk(data, token, prefix);
}

interface ArgView {
	count: number;
	valueAt(index: number): string;
}

function keyArgumentIndices(data: Buffer, elements: BulkToken[]): Set<number> {
	const commandName = bulkValueAsString(data, elements[0]);
	const args = makeArgView(data, elements);
	const spec = KEY_RESOLVERS[commandName];
	const indices = spec ? resolveVariadicKeys(spec, args) : patternIndices(KEY_POSITIONS[commandName], args.count);
	return new Set(indices);
}

function makeArgView(data: Buffer, elements: BulkToken[]): ArgView {
	return {
		count: elements.length - 1,
		valueAt: (index) => bulkValueAsString(data, elements[index + 1]),
	};
}

function patternIndices(keyPattern: KeyPattern | undefined, argCount: number): number[] {
	if (keyPattern === undefined) {
		return [];
	}
	if (Array.isArray(keyPattern)) {
		return keyPattern;
	}
	return range(0, argCount).filter((index) => PATTERN_MATCHERS[keyPattern](index));
}

type VariadicResolver<K extends VariadicSpec['kind']> = (spec: Extract<VariadicSpec, { kind: K }>, args: ArgView) => number[];

const VARIADIC_RESOLVERS: { [K in VariadicSpec['kind']]: VariadicResolver<K> } = {
	restFrom: (spec, args) => range(spec.from, args.count),
	restButLast: (spec, args) => range(spec.from, args.count - 1),
	numkeyed: numkeyedIndices,
	subcommandKey: subcommandIndices,
	sort: sortKeyIndices,
	radiusStore: radiusStoreIndices,
	streams: streamsIndices,
	migrate: migrateIndices,
};

function resolveVariadicKeys(spec: VariadicSpec, args: ArgView): number[] {
	const resolve = VARIADIC_RESOLVERS[spec.kind] as (spec: VariadicSpec, args: ArgView) => number[];
	return resolve(spec, args);
}

function numkeyedIndices(spec: Extract<VariadicSpec, { kind: 'numkeyed' }>, args: ArgView): number[] {
	const count = parseInt(args.valueAt(spec.countAt), 10);
	const first = spec.countAt + 1;
	if (!isValidKeyCount(count, first, args.count)) {
		return spec.extraKeys ?? [];
	}
	return [...(spec.extraKeys ?? []), ...range(first, first + count)];
}

function isValidKeyCount(count: number, first: number, argCount: number): boolean {
	return !Number.isNaN(count) && count >= 0 && first + count <= argCount;
}

function subcommandIndices(spec: Extract<VariadicSpec, { kind: 'subcommandKey' }>, args: ArgView): number[] {
	if (args.count <= spec.keyAt || !spec.subcommands.includes(args.valueAt(0))) {
		return [];
	}
	return [spec.keyAt];
}

function sortKeyIndices(spec: Extract<VariadicSpec, { kind: 'sort' }>, args: ArgView): number[] {
	const keys = [spec.first];
	let index = spec.first + 1;
	while (index < args.count) {
		index = scanSortToken(args, index, keys);
	}
	return keys;
}

function scanSortToken(args: ArgView, index: number, keys: number[]): number {
	const keyword = args.valueAt(index);
	if (!introducesSortKey(keyword) || index + 1 >= args.count) {
		return index + 1;
	}
	if (!isSortSelfReference(keyword, args.valueAt(index + 1))) {
		keys.push(index + 1);
	}
	return index + 2;
}

function introducesSortKey(keyword: string): boolean {
	return keyword === 'by' || keyword === 'get' || keyword === 'store';
}

function isSortSelfReference(keyword: string, pattern: string): boolean {
	return keyword === 'get' && pattern === '#';
}

// GEORADIUS[BYMEMBER]: the source key, plus each STORE/STOREDIST destination key.
function radiusStoreIndices(spec: Extract<VariadicSpec, { kind: 'radiusStore' }>, args: ArgView): number[] {
	const keys = [spec.first];
	for (let index = spec.first + 1; index < args.count - 1; index++) {
		const keyword = args.valueAt(index);
		if (keyword === 'store' || keyword === 'storedist') {
			keys.push(index + 1);
		}
	}
	return keys;
}

// XREAD / XREADGROUP: after the STREAMS token the tail is `key… id…`; its first half are keys.
function streamsIndices(_spec: Extract<VariadicSpec, { kind: 'streams' }>, args: ArgView): number[] {
	const streamsAt = findKeyword(args, 'streams', 0);
	if (streamsAt < 0) {
		return [];
	}
	const remaining = args.count - (streamsAt + 1);
	if (remaining <= 0 || remaining % 2 !== 0) {
		return [];
	}
	return range(streamsAt + 1, streamsAt + 1 + remaining / 2);
}

// MIGRATE: the multi-key form lists keys after a KEYS clause (the fixed key slot is then empty and
// must be left untouched); otherwise the single key sits at index 2 (after host and port).
function migrateIndices(_spec: Extract<VariadicSpec, { kind: 'migrate' }>, args: ArgView): number[] {
	// The KEYS clause can only appear after the fixed host/port/key/db/timeout args, so start at 5 to
	// avoid mistaking an actual key (or option value) named "keys" for the clause marker.
	const keysAt = findKeyword(args, 'keys', 5);
	if (keysAt >= 0) {
		return range(keysAt + 1, args.count);
	}
	return args.count > 2 ? [2] : [];
}

function findKeyword(args: ArgView, keyword: string, from: number): number {
	for (let index = Math.max(from, 0); index < args.count; index++) {
		if (args.valueAt(index) === keyword) {
			return index;
		}
	}
	return -1;
}

function range(from: number, endExclusive: number): number[] {
	const indices: number[] = [];
	for (let index = Math.max(from, 0); index < endExclusive; index++) {
		indices.push(index);
	}
	return indices;
}

/**
 * Strips the prefix from every complete top-level reply at the front of `data`.
 * Each top-level reply is framed transactionally: its rebuilt bytes are committed only
 * once the whole (possibly nested) value has arrived, so an incomplete trailing reply is
 * left unconsumed for reassembly rather than partially emitted.
 */
function stripCompleteValues(data: Buffer, prefix: Buffer): WalkResult {
	const output: Buffer[] = [];
	let offset = 0;

	while (offset < data.length) {
		const frame: Buffer[] = [];
		const next = stripValue(data, offset, prefix, frame);
		if (next === null) {
			break;
		}
		output.push(concatOrEmpty(frame));
		offset = next;
	}

	return { output: concatOrEmpty(output), consumed: offset };
}

function stripValue(data: Buffer, offset: number, prefix: Buffer, chunks: Buffer[]): number | null {
	const type = data[offset];
	if (type === RESP_U8.BULK) {
		return stripBulkValue(data, offset, prefix, chunks);
	}
	if (type === RESP_U8.ARRAY) {
		return stripArrayValue(data, offset, prefix, chunks);
	}
	return stripSimpleLine(data, offset, chunks);
}

function stripBulkValue(data: Buffer, offset: number, prefix: Buffer, chunks: Buffer[]): number | null {
	const token = readBulk(data, offset);
	if (!token) {
		return null;
	}
	if (token.isNull) {
		chunks.push(rawBulk(data, token));
		return token.next;
	}
	chunks.push(stripBulk(data, token, prefix));
	return token.next;
}

function stripArrayValue(data: Buffer, offset: number, prefix: Buffer, chunks: Buffer[]): number | null {
	const header = readArrayHeader(data, offset);
	if (!header) {
		return null;
	}
	chunks.push(data.subarray(header.start, header.next));
	if (header.count < 0) {
		return header.next;
	}
	return stripElements(data, header.next, header.count, prefix, chunks);
}

function stripElements(data: Buffer, offset: number, count: number, prefix: Buffer, chunks: Buffer[]): number | null {
	let cursor = offset;
	for (let index = 0; index < count; index++) {
		const next = stripValue(data, cursor, prefix, chunks);
		if (next === null) {
			return null;
		}
		cursor = next;
	}
	return cursor;
}

function stripSimpleLine(data: Buffer, offset: number, chunks: Buffer[]): number | null {
	const lineEnd = data.indexOf(CRLF, offset);
	if (lineEnd < 0) {
		return null;
	}
	const next = lineEnd + CRLF.length;
	chunks.push(data.subarray(offset, next));
	return next;
}

function stripBulk(data: Buffer, token: BulkToken, prefix: Buffer): Buffer {
	if (!startsWithPrefix(data, token, prefix)) {
		return rawBulk(data, token);
	}
	return encodeBulk(data.subarray(token.valueStart + prefix.length, token.valueEnd));
}

function readArrayHeader(data: Buffer, offset: number): ArrayHeader | null {
	if (data[offset] !== RESP_U8.ARRAY) {
		return null;
	}
	const lineEnd = data.indexOf(CRLF, offset);
	if (lineEnd < 0) {
		return null;
	}
	const count = parseInt(data.toString('latin1', offset + 1, lineEnd), 10);
	if (Number.isNaN(count)) {
		return null;
	}
	return { start: offset, count, next: lineEnd + CRLF.length };
}

function readBulk(data: Buffer, offset: number): BulkToken | null {
	if (data[offset] !== RESP_U8.BULK) {
		return null;
	}
	const lineEnd = data.indexOf(CRLF, offset);
	if (lineEnd < 0) {
		return null;
	}
	const length = parseInt(data.toString('latin1', offset + 1, lineEnd), 10);
	if (Number.isNaN(length)) {
		return null;
	}
	return buildBulkToken(offset, lineEnd + CRLF.length, length, data.length);
}

function buildBulkToken(start: number, valueStart: number, length: number, dataLength: number): BulkToken | null {
	if (length < 0) {
		return { start, valueStart, valueEnd: valueStart, next: valueStart, isNull: true };
	}
	const valueEnd = valueStart + length;
	const next = valueEnd + CRLF.length;
	if (next > dataLength) {
		return null;
	}
	return { start, valueStart, valueEnd, next, isNull: false };
}

function startsWithPrefix(data: Buffer, token: BulkToken, prefix: Buffer): boolean {
	if (token.valueEnd - token.valueStart < prefix.length) {
		return false;
	}
	return data.subarray(token.valueStart, token.valueStart + prefix.length).equals(prefix);
}

function bulkValueAsString(data: Buffer, token: BulkToken): string {
	return data.toString('latin1', token.valueStart, token.valueEnd).toLowerCase();
}

function rawBulk(data: Buffer, token: BulkToken): Buffer {
	return data.subarray(token.start, token.next);
}

function prefixedBulk(data: Buffer, token: BulkToken, prefix: Buffer): Buffer {
	return encodeBulk(Buffer.concat([prefix, data.subarray(token.valueStart, token.valueEnd)]));
}

function encodeBulk(value: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`${RESP.BULK}${value.length}${RESP_SPLIT}`, 'latin1'), value, CRLF]);
}

function concatOrEmpty(chunks: Buffer[]): Buffer {
	return chunks.length ? Buffer.concat(chunks) : EMPTY_BUFFER;
}
