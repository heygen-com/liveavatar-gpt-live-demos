import { defineConfig } from "vite";

// The web app and the orchestrator are one origin from the browser's point of
// view: in dev this proxy forwards /api and /ws to the server (:8787), in
// production the server serves web/dist itself.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
