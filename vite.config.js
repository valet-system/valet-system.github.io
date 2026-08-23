import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@/components/...` instead of `../../../components/...`
    // Keeps imports stable when files move between folders.
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 4000,
    host: true,
  },
  build: {
    sourcemap: true,

    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // A NOTE FOR WHOEVER ADDS A BIG, RARELY-USED DEPENDENCY HERE.
          //
          // A spreadsheet writer used to live in this list, reached only through
          // `await import()` so that nobody downloaded it until they clicked
          // Export. Naming a chunk for it broke exactly that: every unnamed
          // dependency falls through to 'vendor' below, vendor is in the entry
          // graph, and the entry graph is preloaded from index.html. Measured,
          // it went from "on demand for one admin" to "78 kB on first paint for
          // every operator", and appeared in index.html as a preload.
          //
          // So if you add something lazy, `return undefined` for it and let
          // Rollup give it its own async chunk.

          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('react-router') || id.includes('@remix-run')) return 'router'
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) {
            return 'react'
          }

          return 'vendor'
        },
      },
    },
  },
})
