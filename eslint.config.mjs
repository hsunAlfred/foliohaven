import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import astro from 'eslint-plugin-astro';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const javascriptFiles = ['**/*.{js,mjs,cjs,jsx}'];
const typescriptFiles = ['**/*.{ts,mts,cts,tsx}'];
const sourceFiles = [...javascriptFiles, ...typescriptFiles, '**/*.astro'];
const impureBrowserGlobals = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'self',
  'fetch',
];

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.astro/**',
    '**/.vite/**',
    '**/.wrangler/**',
    '**/coverage/**',
    '.foliohaven/**',
    '.alfred/**',
    'media/**',
    'content/**',
  ]),
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  {
    files: javascriptFiles,
    extends: [js.configs.recommended],
  },
  {
    files: typescriptFiles,
    extends: [js.configs.recommended, tseslint.configs.strict],
    languageOptions: {
      parserOptions: {
        onUnsupportedTypeScriptVersion: 'error',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...astro.configs.recommended,
  {
    files: ['**/*.astro'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        onUnsupportedTypeScriptVersion: 'error',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: [
      '*.{js,mjs,cjs,ts,mts,cts}',
      'scripts/**/*.{js,mjs,cjs,ts,mts,cts}',
      'server/**/*.{js,mjs,cjs,ts,mts,cts,tsx}',
      'packages/core/src/node/**/*.{js,mjs,cjs,ts,mts,cts}',
      'site/**/*.{js,mjs,cjs,ts,mts,cts,astro}',
      'studio/vite.config.{js,mjs,ts,mts}',
      'tests/**/*.{js,mjs,cjs,ts,mts,cts,tsx}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      'packages/ui/src/**/*.{js,jsx,ts,tsx}',
      'studio/src/**/*.{js,jsx,ts,tsx}',
      'site/src/**/*.astro/*.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'packages/core/src/**/*.{js,mjs,cjs,ts,mts,cts}',
      'packages/ui/src/**/*.{js,jsx,ts,tsx}',
      'studio/src/**/*.{js,jsx,ts,tsx}',
    ],
    ignores: ['packages/core/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                ...builtinModules,
                '@foliohaven/core/node',
                '**/node/**',
                '**/node',
              ],
              message: '瀏覽器與 Core 純模組不能依賴 Node 專用入口。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.{js,mjs,cjs,ts,mts,cts}'],
    ignores: ['packages/core/src/node/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          globals: impureBrowserGlobals.map((name) => ({
            name,
            message: 'Core 純函式不能存取瀏覽器狀態或執行網路 I/O。',
          })),
          checkGlobalObject: true,
        },
      ],
      'no-restricted-properties': [
        'error',
        ...impureBrowserGlobals.map((property) => ({
          object: 'globalThis',
          property,
          message: 'Core 純函式不能存取瀏覽器狀態或執行網路 I/O。',
        })),
      ],
    },
  },
  {
    files: ['packages/ui/src/**/*.{jsx,tsx}', 'studio/src/**/*.{jsx,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ['studio/src/**/*.{jsx,tsx}'],
    extends: [reactRefresh.configs.vite],
  },
  prettier,
);
