import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  define: { __ACA_DEFAULT_SERVICE_URL__: JSON.stringify(process.env.ACA_DEFAULT_SERVICE_URL ?? '') },
  root: 'src/web', base: './', plugins: [react(), ...(mode === 'tauri' ? [{
    name: 'tauri-native-csp',
    // Tauri supplies its own CSP, including its restricted IPC origins. The
    // browser/Electron meta policy would block native RPC and Vite refresh.
    transformIndexHtml: (html: string) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*\/>/, ''),
  }] : [])],
  build: { outDir: mode === 'tauri' ? '../../dist/tauri-web' : '../../dist/web', emptyOutDir: true },
  server: { port: 5173, strictPort: true, proxy: mode === 'tauri' ? undefined : { '^/api/': 'http://127.0.0.1:4317', '/health': 'http://127.0.0.1:4317' } },
}));
