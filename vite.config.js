import { copyFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'ensure-mp-ws-config',
      closeBundle() {
        const src = resolve('public/mp-ws-config.json')
        const dest = resolve('dist/mp-ws-config.json')
        if (existsSync(src)) copyFileSync(src, dest)
      },
    },
  ],
})
