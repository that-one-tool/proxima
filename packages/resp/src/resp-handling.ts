import { KEY_POSITIONS, KEY_RESOLVERS, KeyPattern, RESP, RESP_SPLIT, RESP_U8, VariadicSpec } from './resp-constants';

const CRLF = Buffer.from(RESP_SPLIT, 'latin1');

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

/**
 * Prefixes the key arguments of every RESP command frame in the buffer.
 * The buffer may hold several coalesced commands; each is parsed by its declared
 * `*N` element count and `$<len>` byte lengths, so binary-safe values round-trip losslessly.
 */
export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	if (!data.length || !keyPrefix || data[0] !== RESP_U8.ARRAY) {
		return data;
	}

	const prefix = Buffer.from(keyPrefix, 'latin1');
	const chunks: Buffer[] = [];
	prefixAllCommands(data, prefix, chunks);
	return Buffer.concat(chunks);
}

/**
 * Removes the prefix from every key value in a RESP response, parsing frames by
 * their declared byte lengths so binary values and null bulks stay aligned.
 */
export function removePrefixFromRedisResponse(data: Buffer, keyPrefix: string): Buffer {
	if (shouldSkipStrip(data, keyPrefix)) {
		return data;
	}

	const prefix = Buffer.from(keyPrefix, 'latin1');
	const chunks: Buffer[] = [];
	stripAllValues(data, prefix, chunks);
	return Buffer.concat(chunks);
}

function shouldSkipStrip(data: Buffer, keyPrefix: string): boolean {
	return !data.length || !keyPrefix || !isStrippableResponse(data[0]);
}

function isStrippableResponse(firstByte: number): boolean {
	return firstByte === RESP_U8.BULK || firstByte === RESP_U8.ARRAY;
}

function prefixAllCommands(data: Buffer, prefix: Buffer, chunks: Buffer[]): void {
	let offset = 0;
	while (offset < data.length) {
		const next = prefixCommand(data, offset, prefix, chunks);
		if (next === null) {
			chunks.push(data.subarray(offset));
			return;
		}
		offset = next;
	}
}

function prefixCommand(data: Buffer, offset: number, prefix: Buffer, chunks: Buffer[]): number | null {
	const elements = readCommandElements(data, offset);
	if (!elements) {
		return null;
	}

	rebuildCommand(data, offset, elements, prefix, chunks);
	return elements[elements.length - 1].next;
}

function readCommandElements(data: Buffer, offset: number): BulkToken[] | null {
	const header = readArrayHeader(data, offset);
	if (!header || header.count <= 0) {
		return null;
	}
	return readBulkElements(data, header.next, header.count);
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

function rebuildCommand(data: Buffer, offset: number, elements: BulkToken[], prefix: Buffer, chunks: Buffer[]): void {
	chunks.push(data.subarray(offset, elements[0].start));
	chunks.push(rawBulk(data, elements[0]));
	const keyArgs = keyArgumentIndices(data, elements);
	for (let argIndex = 0; argIndex < elements.length - 1; argIndex++) {
		chunks.push(maybePrefix(data, elements[argIndex + 1], keyArgs.has(argIndex), prefix));
	}
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

function range(from: number, endExclusive: number): number[] {
	const indices: number[] = [];
	for (let index = Math.max(from, 0); index < endExclusive; index++) {
		indices.push(index);
	}
	return indices;
}

function stripAllValues(data: Buffer, prefix: Buffer, chunks: Buffer[]): void {
	let offset = 0;
	while (offset < data.length) {
		const next = stripValue(data, offset, prefix, chunks);
		if (next === null) {
			chunks.push(data.subarray(offset));
			return;
		}
		offset = next;
	}
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
