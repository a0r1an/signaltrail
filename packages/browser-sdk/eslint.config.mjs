import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['tests/browser/harness/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        crypto: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
