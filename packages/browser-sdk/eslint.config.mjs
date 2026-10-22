import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['e2e/**/*.js'],
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
    files: ['src/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
