import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      reporter: ['text', 'lcov'],
      // A floor, not a target. It sits below what the suite currently reaches
      // so an honest refactor does not trip it, and high enough that deleting
      // a test to make a change pass fails the build instead.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
})
