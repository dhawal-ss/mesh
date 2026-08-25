import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

const zustandStoreCall = 'CallExpression[callee.name=/^use[A-Z][A-Za-z0-9]*Store$/]'
// The only files allowed to reach for the real framer-motion entrypoint.
// Everything else goes through src/lib/lazy-motion so the LazyMotion split in
// src/main.tsx keeps the full DOM feature set out of the startup graph.
const motionBoundaryFiles = [
  // Re-exports the lightweight `m` components plus AnimatePresence.
  'src/lib/lazy-motion.ts',
  // Supplies the dynamically imported feature bundle.
  'src/lib/motion-features.ts',
  // Type-only import of Transition and Variants, erased at build time.
  'src/lib/motion.ts',
  // Mounts LazyMotion and MotionConfig, neither of which pulls in features.
  'src/main.tsx',
  // Uses layoutId for the shared tab indicator. Layout projection is not part
  // of domAnimation, and this modal is only ever React.lazy loaded, so the
  // projection code stays out of the entry and eager chunks.
]
// The only files allowed to reach the Tauri IPC entrypoint. Every renderer
// command goes through src/lib/bridge.ts, which is the one file
// check-tauri-ipc-contract.mjs reads for call sites -- so a single invoke()
// anywhere else does not become an unchecked command, it makes that command
// invisible to the registered-but-never-invoked check as well. The boundary was
// a convention until now; this is what makes it a boundary.
const ipcBoundaryFiles = [
  // The chokepoint itself.
  'src/lib/bridge.ts',
  // The bridge's own suites import invoke to assert against the mocked module.
  'src/lib/bridge.invites.test.ts',
  'src/lib/bridge.message-boundary.test.ts',
  'src/lib/bridge.resilience.test.ts',
  'src/lib/bridge.voice-boundary.test.ts',
]
const motionImportRestriction = {
  name: 'framer-motion',
  message:
    'Import motion and AnimatePresence from src/lib/lazy-motion instead; '
    + 'a bare framer-motion import statically bundles the whole DOM feature '
    + 'set, including layout projection, and defeats the LazyMotion split.',
}
const ipcImportRestriction = {
  name: '@tauri-apps/api/core',
  // isTauri is an environment probe with no command surface and is imported
  // freely; invoke is the boundary.
  importNames: ['invoke'],
  message:
    'Call the native backend through src/lib/bridge.ts instead; invoke() elsewhere '
    + 'escapes the IPC contract check, which reads bridge.ts alone for call sites.',
}
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
      'no-restricted-imports': [
        'error',
        { paths: [motionImportRestriction, ipcImportRestriction] },
      ],
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
  {
    // The motion boundary itself, plus the one component that still needs
    // layout projection. See motionBoundaryFiles for why each entry is here.
    // Each boundary is waived only for its own files, never both at once.
    files: motionBoundaryFiles,
    rules: {
      'no-restricted-imports': ['error', { paths: [ipcImportRestriction] }],
    },
  },
  {
    // The IPC boundary itself. See ipcBoundaryFiles.
    files: ipcBoundaryFiles,
    rules: {
      'no-restricted-imports': ['error', { paths: [motionImportRestriction] }],
    },
  },
  {
    /*
      A store that holds account data must say how it forgets an account.

      This used to live in account-transition.ts, which inlined the initial
      state of nine stores in a file their authors had no reason to open. Any
      field added afterwards survived an account switch in silence, and
      useThreadListStore was missed exactly that way -- one account's thread
      list stayed on screen for the next.

      Selector rather than a naming convention, because the thing that matters
      is that state was created, not what the file is called.
    */
    files: ['src/store/*.ts'],
    ignores: ['src/store/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Program:not(:has(CallExpression[callee.name=registerAccountReset]))'
            + ' CallExpression[callee.name=create]',
          message:
            'A store that creates account-scoped state must call '
            + 'registerAccountReset from lib/account-reset-registry beside it, so '
            + 'the reset lives next to the shape it resets. If this store holds '
            + 'nothing belonging to an account, register a reset that clears '
            + 'nothing and say so.',
        },
      ],
    },
  },
]
