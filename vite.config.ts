import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves the site from /<repo-name>/. Override with VITE_BASE if the repo is renamed.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/cader-mailer/',
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false },
})
