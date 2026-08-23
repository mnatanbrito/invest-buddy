import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Reuses the app's path aliases rather than restating them, so @/ and @shared/
// can never mean one thing at build time and another under test.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['shared/**/*.test.ts', 'src/**/*.test.ts', 'server/**/*.test.ts'],
    },
  }),
);
