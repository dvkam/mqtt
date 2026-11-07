import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Archived AVA fixtures stay outside Vitest until their unique coverage is migrated in #42.
    include: ['test/**/*.test.ts'],
    allowOnly: false,
    expect: { requireAssertions: true },
  },
});
