import { config } from '@repo/eslint/base';

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		// node:test `describe`/`it`/`before`/`after` intentionally return promises that are not awaited
		// by the caller; the runner tracks them. Awaiting them here would be wrong, so relax the rule.
		files: ['**/test/**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},
];
