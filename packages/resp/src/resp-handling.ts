import { KEY_COMMANDS, RESP_TYPES } from './resp-constants';

export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	const dataStr = data.toString();

	if (!dataStr.startsWith('*')) {
		// For any other RESP type or non-RESP format, pass through unchanged
		return data;
	}

	// Only handle RESP protocol array commands starting with '*'
	const lines = dataStr.split('\r\n');
	const newLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		if (i === 0 || !lines[i].startsWith('$')) {
			// Array header line (e.g., *3) OR any other part of the RESP protocol, copy as is
			newLines.push(lines[i]);
			i++;
			continue;
		}

		// String length marker
		const command = lines[i + 1];
		newLines.push(lines[i]);
		newLines.push(command);
		i += 2;

		// Process the arguments (key is usually the first argument)
		// Check if this is a command that needs key prefixing
		const cmdLower = command.toLowerCase();
		const needsPrefixing = KEY_COMMANDS.includes(cmdLower);
		const shouldPrefix = needsPrefixing && i < lines.length && lines[i].startsWith('$');

		if (!shouldPrefix) {
			continue;
		}

		// This is the key
		let key = lines[i + 1];

		// Add prefix if not already prefixed
		if (!key.startsWith(keyPrefix)) {
			key = keyPrefix + key;
		}

		// Update the length marker for the prefixed key
		const newKeyLength = Buffer.byteLength(key);
		newLines.push(`$${newKeyLength}`);
		newLines.push(key);
		i += 2;
	}

	return Buffer.from(newLines.join('\r\n'));
}

/**
 * Removes prefixes from keys in Redis responses
 *
 * @param data The response data from Redis server
 * @param keyPrefix The prefix to remove from keys
 * @returns Modified response with prefixes removed
 */
export function removePrefixFromRedisResponse(data: Buffer, keyPrefix: string): Buffer {
	const dataStr = data.toString();
	const firstChar = dataStr.charAt(0);
	const isBulkString = dataStr.startsWith('$');
	const isArray = dataStr.startsWith('*');

	if (!RESP_TYPES.includes(firstChar) || (!isBulkString && !isArray)) {
		// Not a RESP protocol response, return as is
		// OR simple string, error, or integer responses - pass through as they don't contain keys
		return data;
	}

	if (isBulkString) {
		// Bulk string response - might be a key value
		return processBulkStringResponse(dataStr, keyPrefix);
	}

	// Array response (e.g., from KEYS, LRANGE, etc.)
	return processArrayResponse(dataStr, keyPrefix);
}

/**
 * Process a bulk string response (starts with $) and remove prefix if it's a key
 */
function processBulkStringResponse(dataStr: string, keyPrefix: string): Buffer {
	// Check if it's a null bulk string ($-1\r\n)
	if (dataStr.startsWith('$-1')) {
		return Buffer.from(dataStr);
	}

	const lines = dataStr.split('\r\n');
	if (lines.length < 2) {
		return Buffer.from(dataStr);
	}

	// Get the value string
	const value = lines[1];

	// Not prefixed or not a key, return as is
	if (!value.startsWith(keyPrefix)) {
		return Buffer.from(dataStr);
	}

	const unprefixedValue = value.substring(keyPrefix.length);
	const newLength = Buffer.byteLength(unprefixedValue);

	// Reconstruct the response
	return Buffer.from(`$${newLength}\r\n${unprefixedValue}\r\n`);
}

/**
 * Process an array response (starts with *) and remove prefix from each element if it's a key
 */
function processArrayResponse(dataStr: string, keyPrefix: string): Buffer {
	const lines = dataStr.split('\r\n');
	const newLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		if (i === 0 || !lines[i].startsWith('$')) {
			// Array header (e.g., *3) OR any other part than a bulk string, copy as is
			newLines.push(lines[i]);
			i++;
			continue;
		}

		// Bulk string length marker
		const lengthLine = lines[i];
		const value = lines[i + 1];

		i += 2;

		if (!value || !value.startsWith(keyPrefix)) {
			// Keep as is if not prefixed or empty
			newLines.push(lengthLine);
			newLines.push(value);
			continue;
		}

		const unprefixedValue = value.substring(keyPrefix.length);
		const newLength = Buffer.byteLength(unprefixedValue);
		newLines.push(`$${newLength}`);
		newLines.push(unprefixedValue);
	}

	return Buffer.from(newLines.join('\r\n'));
}
