import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests-ts/**/*.test.ts', 'frontend/src/**/*.test.tsx'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
