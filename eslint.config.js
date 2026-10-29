const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'eval/results/**', 'assets/**', 'src/renderer/phone.html', 'web/**', 'defaults/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/main/**/*.js', 'src/shared/**/*.js', 'src/preload.js', 'scripts/**/*.js', 'test/**/*.js', 'server/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // AudioWorklet global scope (not in globals.browser).
    files: ['src/renderer/worklet.js'],
    languageOptions: { globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' } },
  },
];
