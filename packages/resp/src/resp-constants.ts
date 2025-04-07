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

export const RESP = {
	BULK: '$',
	ARRAY: '*',
	STRING: '+',
	ERROR: '-',
	INT: ':',
	NULL: '|',
};
export const RESP_U8 = {
	BULK: 36,
	ARRAY: 42,
	STRING: 43,
	ERROR: 45,
	INT: 58,
	NULL: 124,
};
export const RESP_U8_LIST = Object.values(RESP_U8);
export const RESP_SPLIT = '\r\n';

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
