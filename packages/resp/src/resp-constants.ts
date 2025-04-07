export const KEY_COMMANDS = [
	'get',
	'set',
	'hget',
	'hset',
	'del',
	'exists',
	'incr',
	'decr',
	'lpush',
	'rpush',
	'lrange',
	'expire',
	'ttl',
	'mset',
	'mget',
];

export const RESP_TYPES = ['+', '-', ':', '$', '*'];

// Maps commands to patterns of which arguments are keys
// 0-based index or string pattern ('even', 'odd', 'all')
export const KEY_POSITIONS: Record<string, number[] | 'even' | 'odd' | 'all'> = {
	get: [0],
	set: [0],
	hget: [0],
	hset: [0],
	del: 'all',
	exists: 'all',
	incr: [0],
	decr: [0],
	lpush: [0],
	rpush: [0],
	lrange: [0],
	expire: [0],
	ttl: [0],
	mget: 'all',
	mset: 'even', // For MSET, keys are at positions 0, 2, 4, etc.
};
