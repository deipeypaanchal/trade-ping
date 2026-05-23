import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // We intentionally do NOT silence no-explicit-any. AlertService
      // historically rendered untyped trade events; a typo there was invisible
      // at compile time. Keep this strict so future regressions get flagged.
    },
  },
];
