import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

const zustandStoreCall = 'CallExpression[callee.name=/^use[A-Z][A-Za-z0-9]*Store$/]'
const compilerDiagnostics = Object.fromEntries(
  Object.keys(reactHooks.configs.flat.recommended.rules).map((rule) => [rule, 'warn']),
)

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Existing components are adopted incrementally: the compiler skips
      // unsafe components and these warnings keep the migration visible.
      ...compilerDiagnostics,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          selector: `${zustandStoreCall}[arguments.length=0]`,
          message: 'Select one field from Zustand instead of subscribing to the entire store.',
        },
        {
          selector:
            `${zustandStoreCall} ArrowFunctionExpression CallExpression`
            + '[callee.property.name=/^(filter|map)$/]',
          message:
            'Do not allocate arrays inside Zustand selectors; select stable state and derive it outside.',
        },
        {
          selector: `${zustandStoreCall} ArrowFunctionExpression ObjectExpression`,
          message:
            'Do not allocate object literals inside Zustand selectors; use individual selectors.',
        },
      ],
    },
  },
]
