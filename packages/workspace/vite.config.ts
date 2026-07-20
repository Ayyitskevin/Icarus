import { defineConfig } from "vite";

const LOOPBACK_HOST = "127.0.0.1";

export default defineConfig({
  server: {
    host: LOOPBACK_HOST,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: LOOPBACK_HOST,
    port: 4173,
    strictPort: true,
  },
});
