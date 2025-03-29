import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-prettier';
import turboPlugin from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config}
 * */
export const config = [
	eslint.configs.recommended,
	eslintConfigPrettier,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		plugins: {
			turbo: turboPlugin,
		},
		rules: {
			'turbo/no-undeclared-env-vars': 'error',
		},
	},
	{
		ignores: ['dist/**/*.ts', 'dist/**', '**/*.mjs', '**/eslint.config.mjs'],
	},
];
