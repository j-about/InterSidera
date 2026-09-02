import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // Generated and output directories; `schema.d.ts` is produced by openapi-typescript (brief l.103).
  globalIgnores(['dist', 'coverage', 'playwright-report', 'test-results', 'src/api/schema.d.ts']),

  // A. Plain JavaScript (this file, Node scripts).
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // B. TypeScript, type-aware (brief l.405 "typescript-eslint (type-aware)", plan D19). The strict
  // preset forbids `!` non-null assertions and floating promises everywhere in the project.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@babylonjs/core',
              message: 'Import from @babylonjs/core/<module> subpaths (tree-shaking, brief l.406).',
            },
            { name: 'babylonjs', message: 'Never the UMD package.' },
          ],
          patterns: [
            {
              group: ['@babylonjs/core/Legacy/*'],
              message: 'Never the Legacy bundle (brief l.541).',
            },
          ],
        },
      ],
    },
  },

  // C. TypeScript that runs under Node rather than in the browser.
  {
    files: ['vite.config.ts', 'playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
]);
