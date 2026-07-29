import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // src/config.ts throws without a token, and several lib modules import it at load
    // time. Tests never make real API calls, so a placeholder is enough.
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN || 'test-token' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts'],
    },
  },
});
