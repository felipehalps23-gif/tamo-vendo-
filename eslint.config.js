import js from '@eslint/js';
import globals from 'globals';
import quality from './eslint-rules/index.cjs';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: globals.node },
    plugins: { quality },
    rules: {
      'quality/max-lines': ['error', { max: 350, includeTests: true }],
      'quality/no-direct-console': 'error'
    }
  },
  { files: ['public/*.js'], languageOptions: { globals: globals.browser }, rules: {
    'no-restricted-imports': ['error', { patterns: ['node:*', '../src/*'] }]
  } },
  { files: ['e2e/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['scripts/**', 'eslint-rules/**'], rules: { 'quality/no-direct-console': 'off' } }
];
