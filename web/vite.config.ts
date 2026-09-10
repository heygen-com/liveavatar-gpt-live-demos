import { defineConfig } from "vite";

// The web app and the orchestrator are one origin from the browser's point of
// view: in dev this proxy forwards /api and /ws to the server (:8789), in
// production the server serves web/dist itself. Ports are +2 from the
// language demo's (8787/5173) so both demos can run side by side.
export default defineConfig({
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:8789",
      "/ws": { target: "ws://localhost:8789", ws: true },
    },
  },
});
