import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tselint from 'typescript-eslint';

export default defineConfig([
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tselint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
]);
