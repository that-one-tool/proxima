import { KEY_COMMANDS, RESP_TYPES, KEY_POSITIONS } from './resp-constants';

export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	const dataStr = data.toString();

	if (!dataStr.startsWith('*')) {
		// For any other RESP type or non-RESP format, pass through unchanged
		return data;
	}

	// Only handle RESP protocol array commands starting with '*'
	const lines = dataStr.split('\r\n');
	const newLines: string[] = [];

	// First line is the array header (*n), push it as is
	newLines.push(lines[0]);

	// Get command name to determine key positions
	let cmdLower = '';
	let argsStartIndex = 0;

	// Process command name (usually second item after array header)
	for (let i = 1; i < lines.length; i++) {
		newLines.push(lines[i]);

		if (lines[i].startsWith('$')) {
			// Next line is the string content
			if (i + 1 < lines.length) {
				const value = lines[i + 1];
				newLines.push(value);

				// If this is the first string (command name)
				if (cmdLower === '') {
					cmdLower = value.toLowerCase();
					argsStartIndex = i + 2; // Arguments start after command name
					break;
				}
			}

			i++; // Skip string content in next iteration
		}
	}

	// If not a key command or not found in KEY_POSITIONS, pass through the rest unchanged
	if (!KEY_COMMANDS.includes(cmdLower) || !(cmdLower in KEY_POSITIONS)) {
		for (let i = argsStartIndex; i < lines.length; i++) {
			if (i < lines.length) {
				newLines.push(lines[i]);
			}
		}

		return Buffer.from(newLines.join('\r\n'));
	}

	// Determine which arguments are keys
	const keyPattern = KEY_POSITIONS[cmdLower];

	// Process arguments
	let argIndex = 0;
	for (let i = argsStartIndex; i < lines.length; i++) {
		if (!lines[i].startsWith('$')) {
			newLines.push(lines[i]);
			continue;
		}

		// This is a string length marker
		const lengthLine = lines[i];

		if (i + 1 >= lines.length) {
			newLines.push(lengthLine);
			continue;
		}

		// Next line is the string content
		const value = lines[i + 1];

		// Check if this argument is a key that needs prefixing
		let isKey =
			keyPattern === 'all' ||
			(keyPattern === 'even' && argIndex % 2 === 0) ||
			(keyPattern === 'odd' && argIndex % 2 === 1) ||
			(Array.isArray(keyPattern) && keyPattern.includes(argIndex));

		if (isKey && !value.startsWith(keyPrefix)) {
			const prefixedKey = keyPrefix + value;
			const newKeyLength = Buffer.byteLength(prefixedKey);

			newLines.push(`$${newKeyLength}`);
			newLines.push(prefixedKey);
		} else {
			newLines.push(lengthLine);
			newLines.push(value);
		}

		argIndex++;
		i++; // Skip string content in next iteration
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
