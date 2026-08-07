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
