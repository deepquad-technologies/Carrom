import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@carrom/types': pkg('types'),
      '@carrom/config': pkg('config'),
      '@carrom/physics': pkg('physics'),
      '@carrom/game-engine': pkg('game-engine'),
      '@carrom/content': pkg('content'),
      '@carrom/networking': pkg('networking'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // The physics suite runs thousands of simulated boards. Spreading that over
    // worker threads is faster on an idle machine but is the first thing to die
    // when memory is tight, so the suite runs in one process by default.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
