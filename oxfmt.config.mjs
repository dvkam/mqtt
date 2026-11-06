import { defineConfig } from 'oxfmt';

export default defineConfig({
  semi: true,
  singleQuote: true,
  printWidth: 132,
  ignorePatterns: ['test/test_*.js', 'test/util/**', 'test/types/attributes.d.ts'],
});
