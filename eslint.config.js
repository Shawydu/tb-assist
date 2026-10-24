import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const CLICK_BAN = {
  selector: 'CallExpression[callee.property.name=/^(click|submit|requestSubmit)$/]',
  message:
    'FR-6: clicks/submits are only allowed via src/runner/clickAllowList.ts (purposes cartCheckbox, cartCheckout).',
};

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } },
    rules: { 'no-restricted-syntax': ['error', CLICK_BAN] },
  },
  {
    files: ['src/runner/clickAllowList.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // NFR-7: pure core/sim
    files: ['src/core/**', 'src/sim/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['chrome', 'document', 'window', 'browser', 'navigator'].map((name) => ({
          name,
          message: 'NFR-7: src/core and src/sim must be pure TS (no DOM/extension APIs).',
        })),
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '#imports', message: 'NFR-7: no extension framework imports in core/sim.' },
          ],
          patterns: [
            {
              group: ['wxt', 'wxt/*', 'webextension-polyfill'],
              message: 'NFR-7: no extension framework imports in core/sim.',
            },
          ],
        },
      ],
    },
  },
);
