const KEY_COMMANDS = ['get', 'set', 'hget', 'hset', 'del', 'exists', 'incr', 'decr', 'lpush', 'rpush', 'lrange', 'expire', 'ttl'];

export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	const dataStr = data.toString();

	// Only handle RESP protocol array commands starting with '*'
	if (dataStr.startsWith('*')) {
		// Array type command
		const lines = dataStr.split('\r\n');
		const newLines: string[] = [];

		let i = 0;
		while (i < lines.length) {
			if (i === 0) {
				// Array header line (e.g., *3)
				newLines.push(lines[i]);
				i++;
				continue;
			}

			if (lines[i].startsWith('$')) {
				// String length marker
				const command = lines[i + 1];
				newLines.push(lines[i]);
				newLines.push(command);
				i += 2;

				// Process the arguments (key is usually the first argument)
				// Check if this is a command that needs key prefixing
				const cmdLower = command.toLowerCase();
				const needsPrefixing = KEY_COMMANDS.includes(cmdLower);

				if (needsPrefixing && i < lines.length && lines[i].startsWith('$')) {
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
			} else {
				// Any other part of the RESP protocol, copy as is
				newLines.push(lines[i]);
				i++;
			}
		}

		return Buffer.from(newLines.join('\r\n'));
	} else {
		// For any other RESP type or non-RESP format, pass through unchanged
		return data;
	}
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

	// Handle different RESP protocol response types
	if (dataStr.startsWith('+') || dataStr.startsWith('-') || dataStr.startsWith(':')) {
		// Simple string, error, or integer responses - pass through as they don't contain keys
		return data;
	} else if (dataStr.startsWith('$')) {
		// Bulk string response - might be a key value
		return processBulkStringResponse(dataStr, keyPrefix);
	} else if (dataStr.startsWith('*')) {
		// Array response (e.g., from KEYS, LRANGE, etc.)
		return processArrayResponse(dataStr, keyPrefix);
	} else {
		// Unknown format, return as is
		return data;
	}
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

	// If the value starts with our prefix, remove it
	if (value.startsWith(keyPrefix)) {
		const unprefixedValue = value.substring(keyPrefix.length);

		// Update the length marker for the unprefixed value
		const newLength = Buffer.byteLength(unprefixedValue);

		// Reconstruct the response
		return Buffer.from(`$${newLength}\r\n${unprefixedValue}\r\n`);
	}

	// Not prefixed or not a key, return as is
	return Buffer.from(dataStr);
}

/**
 * Process an array response (starts with *) and remove prefix from each element if it's a key
 */
function processArrayResponse(dataStr: string, keyPrefix: string): Buffer {
	const lines = dataStr.split('\r\n');
	const newLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		if (i === 0) {
			// Array header (e.g., *3)
			newLines.push(lines[i]);
			i++;
			continue;
		}

		if (lines[i].startsWith('$')) {
			// Bulk string length marker
			const lengthLine = lines[i];
			const value = lines[i + 1];

			// If the value starts with our prefix, remove it
			if (value && value.startsWith(keyPrefix)) {
				const unprefixedValue = value.substring(keyPrefix.length);

				// Update the length marker
				const newLength = Buffer.byteLength(unprefixedValue);
				newLines.push(`$${newLength}`);
				newLines.push(unprefixedValue);
			} else {
				// Keep as is if not prefixed or empty
				newLines.push(lengthLine);
				newLines.push(value);
			}

			i += 2;
		} else {
			// Any other part, copy as is
			newLines.push(lines[i]);
			i++;
		}
	}

	return Buffer.from(newLines.join('\r\n'));
}
