import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single` emits one self-contained index.html (handy for sharing a demo).
export default defineConfig(({ mode }) => ({
  // Relative asset paths so Electron can load the build over file://.
  base: './',
  plugins: [react(), ...(mode === 'singlefile' ? [viteSingleFile()] : [])],
  build: { chunkSizeWarningLimit: 2000 },
}));
