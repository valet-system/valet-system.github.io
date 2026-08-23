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

          // LEFT TO ROLLUP, on purpose — do not name a chunk for this.
          //
          // The spreadsheet writer is only reached through `await import()` in
          // src/utils/xlsx.js, so Rollup will give it its own async chunk and
          // nobody downloads it until they click Export.
          //
          // Naming it here breaks that. Every unnamed dependency falls through
          // to 'vendor' below, vendor is in the entry graph, and the entry graph
          // is preloaded from index.html — so it went from "loaded on demand by
          // a system admin" to "78 kB loaded on first paint by every operator".
          // Measured: it appeared in index.html as a preload.
          if (id.includes('write-excel-file')) return undefined

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
