import { KEY_COMMANDS, KEY_POSITIONS, RESP, RESP_SPLIT, RESP_U8_LIST, RESP_U8 } from './resp-constants';

/**
 * Prefixes keys in Redis commands with a specified prefix
 *
 * @param {Buffer} data The command data buffer from Redis client
 * @param {string} keyPrefix The prefix to add to keys
 * @returns {Buffer} The modified command buffer with prefixed keys
 */
export function prefixRedisKeys(data: Buffer, keyPrefix: string): Buffer {
	if (!data || !keyPrefix || data[0] !== RESP_U8.ARRAY) {
		return data;
	}

	const dataStr = data.toString();
	const lines = dataStr.split(RESP_SPLIT);
	const newLines: string[] = [lines[0]];

	let cmdLower = '';
	let argsStartIndex = 0;

	for (let i = 1; i < lines.length; i++) {
		newLines.push(lines[i]);

		if (lines[i].startsWith(RESP.BULK)) {
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

		return Buffer.from(newLines.join(RESP_SPLIT));
	}

	// Determine which arguments are keys
	const keyPattern = KEY_POSITIONS[cmdLower];

	// Process arguments
	let argIndex = 0;
	for (let i = argsStartIndex; i < lines.length; i++) {
		if (!lines[i].startsWith(RESP.BULK)) {
			newLines.push(lines[i]);
			continue;
		}

		const lengthLine = lines[i];

		if (i + 1 >= lines.length) {
			newLines.push(lengthLine);
			continue;
		}

		// Next line is the string content
		const value = lines[i + 1];

		let isKey =
			keyPattern === 'all' ||
			(keyPattern === 'even' && argIndex % 2 === 0) ||
			(keyPattern === 'odd' && argIndex % 2 === 1) ||
			(Array.isArray(keyPattern) && keyPattern.includes(argIndex));

		if (isKey && !value.startsWith(keyPrefix)) {
			const prefixedKey = keyPrefix + value;
			const newKeyLength = Buffer.byteLength(prefixedKey);

			newLines.push(`${RESP.BULK}${newKeyLength}`);
			newLines.push(prefixedKey);
		} else {
			newLines.push(lengthLine);
			newLines.push(value);
		}

		argIndex++;
		i++; // Skip string content in next iteration
	}

	return Buffer.from(newLines.join(RESP_SPLIT));
}

/**
 * Removes prefixes from keys in Redis responses
 *
 * @param {Buffer} data The response data buffer from Redis server
 * @param {string} keyPrefix The prefix to remove from keys
 * @returns {Buffer} The modified response buffer with prefixes removed
 */
export function removePrefixFromRedisResponse(data: Buffer, keyPrefix: string): Buffer {
	const firstChar = data[0];
	const isBulkString = firstChar === RESP_U8.BULK;
	const isArray = firstChar === RESP_U8.ARRAY;

	if (!RESP_U8_LIST.includes(firstChar) || (!isBulkString && !isArray)) {
		return data;
	}

	const dataStr = data.toString();

	if (isBulkString) {
		return processBulkStringResponse(dataStr, keyPrefix);
	}

	return processArrayResponse(dataStr, keyPrefix);
}

function processBulkStringResponse(dataStr: string, keyPrefix: string): Buffer {
	if (dataStr.startsWith('$-1')) {
		return Buffer.from(dataStr);
	}

	const lines = dataStr.split(RESP_SPLIT);
	if (lines.length < 2) {
		return Buffer.from(dataStr);
	}

	const value = lines[1];

	if (!value.startsWith(keyPrefix)) {
		return Buffer.from(dataStr);
	}

	const unprefixedValue = value.substring(keyPrefix.length);
	const newLength = Buffer.byteLength(unprefixedValue);

	return Buffer.from(`${RESP.BULK}${newLength}${RESP_SPLIT}${unprefixedValue}${RESP_SPLIT}`);
}

function processArrayResponse(dataStr: string, keyPrefix: string): Buffer {
	const lines = dataStr.split(RESP_SPLIT);
	const newLines: string[] = [];

	let i = 0;
	while (i < lines.length) {
		if (i === 0 || !lines[i].startsWith(RESP.BULK)) {
			newLines.push(lines[i]);
			i++;
			continue;
		}

		const lengthLine = lines[i];
		const value = lines[i + 1];

		i += 2;

		if (!value || !value.startsWith(keyPrefix)) {
			newLines.push(lengthLine);
			newLines.push(value);
			continue;
		}

		const unprefixedValue = value.substring(keyPrefix.length);
		const newLength = Buffer.byteLength(unprefixedValue);
		newLines.push(`${RESP.BULK}${newLength}`);
		newLines.push(unprefixedValue);
	}

	return Buffer.from(newLines.join(RESP_SPLIT));
}
