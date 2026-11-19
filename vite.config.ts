import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything the first paint needs ships inside index.html: one request, no waterfall.
export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: { target: 'es2022', cssMinify: true },
});
