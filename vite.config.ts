import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `pnpm dev` proxies /api to the local Docker stack so the browser runs in live mode.
// Set NO_API_PROXY=1 to develop against the labeled demo dataset instead.
const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:15173'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: process.env.NO_API_PROXY ? undefined : { '/api': { target: apiProxyTarget, changeOrigin: true } },
  },
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['chart.js', 'react-chartjs-2'],
          maps: ['leaflet'],
          icons: ['lucide-react'],
        },
      },
    },
  },
})
