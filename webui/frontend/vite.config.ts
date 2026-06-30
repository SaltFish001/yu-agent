import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9876',
      '/ws': {
        target: 'ws://localhost:9876',
        ws: true,
      },
      '/term-ws': {
        target: 'ws://localhost:9876',
        ws: true,
      },
      '/events': 'http://localhost:9876',
    },
  },
})
