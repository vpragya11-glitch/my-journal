import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: change 'sukoon' below to your GitHub repo name
// e.g. if your repo is github.com/yourname/my-sukoon-app, set base: '/my-sukoon-app/'
export default defineConfig({
  plugins: [react()],
  base: '/sukoon/',
})
