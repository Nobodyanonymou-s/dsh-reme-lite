import { defineConfig } from 'tsdown'

// Two targets, the same split the hand-written layout had:
// - Node ESM entries under lib/ (index + store + memctl), with every
//   `@deepseek-ai/*` host package left as a runtime import (never bundled) —
//   in practice only the optional schemastery dynamic import exists, and it
//   must resolve from the host, never from here.
// - Browser client as one classic script: CJS body wrapped in the host's
//   `window.__ModuleLoader__.load({ id, factory: (require) => ... })`
//   contract, identical in shape to the previous hand-written client.js.
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      store: 'src/store.ts',
      memctl: 'src/memctl.ts',
    },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner:
        'window.__ModuleLoader__.load({ id: "dsh-reme-lite", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
