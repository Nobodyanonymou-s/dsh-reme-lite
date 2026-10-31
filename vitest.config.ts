import { defineConfig } from 'vitest/config'

// Share one React instance across DSH client packages and tests.
// globalSetup builds lib/ when missing so artifact tests never silently skip.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'] },
})
