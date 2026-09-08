import { defineConfig } from 'vitest/config';

/**
 * Tests for the parts of the web client that are pure logic — chiefly how the
 * board is drawn. They run against the shared renderer through a recording
 * Painter, so the assertions are about draw calls rather than pixels and hold
 * at any screen size.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The renderer is CPU-only; a DOM would add nothing but startup cost.
    environment: 'node',
  },
});
