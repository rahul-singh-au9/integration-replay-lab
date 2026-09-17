import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/core/schema.ts',
        'src/core/replay.ts',
        'src/core/result.ts',
        'src/core/initialize.ts',
        'src/core/bundle.ts',
        'src/ui/api.ts',
        'src/ui/bundle.ts',
        'worker/index.ts',
      ],
    },
  },
});
