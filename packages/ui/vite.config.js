import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * The web build is a plain static bundle: no API routes, no server rendering,
 * nothing to deploy but files. `base: './'` keeps it working from any
 * subdirectory, which matters because people will drop it on a free static
 * host or serve it straight out of the desktop app.
 */
export default defineConfig({
  base: './',
  plugins: [
    react(),
    // Parts of the libp2p stack still reach for node globals in the browser.
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } })
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2500
  },
  server: {
    port: 5173,
    host: true // so a phone on the same Wi-Fi can open the dev server
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
  }
})
