import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: { correctness: 'error' },
  ignorePatterns: ['dist/**', 'test/test_*.js', 'test/util/**', 'test/types/attributes.d.ts'],
  rules: { 'no-unused-expressions': ['error', { allowTernary: true }] },
});
