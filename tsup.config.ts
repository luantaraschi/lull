import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/core/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
})
