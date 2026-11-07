import { defineConfig } from 'oxlint';

export default defineConfig({
  options: { typeAware: true },
  categories: { correctness: 'error' },
  ignorePatterns: ['dist/**', 'test/test_*.js', 'test/util/**', 'test/types/attributes.d.ts'],
  rules: { 'no-unused-expressions': ['error', { allowTernary: true }] },
  overrides: [
    {
      files: ['**/*.ts'],
      rules: {
        'typescript/no-floating-promises': 'error',
        'typescript/no-misused-promises': 'error',
      },
    },
  ],
});
