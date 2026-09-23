import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', '.examples-check/**', '.examples-run/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['examples/**', 'scripts/**'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', AbortController: 'readonly', setTimeout: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
)
