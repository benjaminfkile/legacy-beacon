import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The service serves the built page and the API from one origin. In dev the
// page runs on its own port and /api goes to a service on localhost:3070
// (LB_API_PROXY overrides, e.g. the service on the LAN host).
const apiTarget = process.env.LB_API_PROXY ?? "http://localhost:3070";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    strictPort: true,
    proxy: { "/api": apiTarget },
  },
  preview: {
    port: 5176,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
