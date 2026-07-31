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
        // Vite is a presentation-only view over an explicitly configured
        // stable GET-only API. Production mutation sessions are always served
        // same-origin by @icarus/api and never cross this proxy.
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (request.method === "GET" || request.method === "HEAD") {
              proxyRequest.removeHeader("origin");
            }
          });
        },
      },
    },
  },
  preview: {
    host: LOOPBACK_HOST,
    port: 4173,
    strictPort: true,
  },
});
