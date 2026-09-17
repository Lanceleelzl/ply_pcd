import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';

const localConfig = JSON.parse(readFileSync(new URL('../config/local.json', import.meta.url), 'utf8')) as { port: number; web_port: number };

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  build: {
    outDir: '../service/static',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: localConfig.web_port,
    proxy: {
      '/api': `http://127.0.0.1:${localConfig.port}`,
      '/gaussian-resources': `http://127.0.0.1:${localConfig.port}`,
      '/health': `http://127.0.0.1:${localConfig.port}`,
      '/docs': `http://127.0.0.1:${localConfig.port}`,
      '/openapi.json': `http://127.0.0.1:${localConfig.port}`
    }
  }
});
