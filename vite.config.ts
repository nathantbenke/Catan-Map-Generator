/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves project repos at username.github.io/<repo-name>/, so
  // every asset path needs to be prefixed with that subpath. Change to '/' if
  // you ever host at the root of a custom domain.
  base: '/catan-map-generator/',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
