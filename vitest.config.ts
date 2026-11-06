import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The inherited AVA integration suite requires a buildable client.
    include: ['test/**/*.test.ts'],
    allowOnly: false,
    expect: { requireAssertions: true },
  },
});
