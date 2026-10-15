import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts?(x)'],
    globals: false,
    passWithNoTests: true,
    restoreMocks: true,
    css: false,
    // Half the logical CPUs. The default (all but one) oversubscribes hybrid laptop CPUs: on the
    // dev host (i9-13900HX, 32 threads) ~18 findBy/waitFor timeouts failed per full run at the
    // default and none at 16 workers, in the same wall time.
    maxWorkers: '50%',
  },
});
