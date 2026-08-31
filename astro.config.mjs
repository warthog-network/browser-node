// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import netlify from '@astrojs/netlify';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Warthog browser full node (WASM).
 * COOP+COEP required for SharedArrayBuffer / pthreads.
 * Production headers: netlify.toml + public/_headers
 */
export default defineConfig({
  output: 'server',
  integrations: [react()],
  adapter: netlify({
    functionPerRoute: false,
    cacheOnDemandPages: true,
  }),
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  vite: {
    define: {
      global: 'globalThis',
    },
    // Reached only through the lazy import('./preshareClient.js') in
    // poolSigner/ethPoolSigner, so Vite's startup scan never sees them and
    // optimizes them mid-session — which invalidates the module graph and
    // fails that dynamic import. Pre-bundle them at boot instead.
    optimizeDeps: {
      include: ['@noble/curves/secp256k1', '@noble/hashes/sha256'],
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      // Local dev only: browser → same-origin /ws-bridge → Official1 wss
      proxy: {
        '/ws-bridge': {
          target: 'https://warthognode.duckdns.org',
          changeOrigin: true,
          secure: true,
          ws: true,
          rewrite: (p) => p.replace(/^\/ws-bridge/, '/ws'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(root, 'src'),
      },
    },
  },
});
