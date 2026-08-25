import { defineConfig } from 'vite';

// 外部アセットの動的ロードは禁止（仕様 2章）。
// Rapier の WASM は rapier3d-compat が base64 で同梱するため、追加設定なしでバンドルに入る。
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
});
