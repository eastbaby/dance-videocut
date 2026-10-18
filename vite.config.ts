import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Electron loads the production UI through file://, which cannot resolve
  // Vite's default absolute /assets URLs.
  base: "./",
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true
  }
});
