import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierPlugin from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', '.claude/**', '.claude-plugin/types/**'],
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierPlugin,
  {
    files: ['tools/**/*.ts'],
    rules: {
      'func-style': ['error', 'expression'],
      'prefer-arrow-callback': 'error',
    },
  },
  {
    files: ['tools/cli/src/workflow-store/store.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression:matches([callee.name=appendFileSync], [callee.property.name=appendFileSync]):not(:has(Property[key.name=mode][value.value=384]))',
          message:
            'appendFileSync here must pass { mode: 0o600 } — the trailing chmodSync repairs the mode but leaves a window where the new file is world-readable.',
        },
      ],
    },
  },
  {}
)
