import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const plugins: any[] = [react()];

  // Only add lovable-tagger in development (safe — not available in CI)
  if (mode === "development") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { componentTagger } = require("lovable-tagger");
      plugins.push(componentTagger());
    } catch {
      // lovable-tagger not installed — skip silently
    }
  }

  return {
    // VITE_BASE_URL must match the GitHub repo path, e.g. /youtube-dark/
    // Falls back to '/' for local dev
    base: process.env.VITE_BASE_URL || "/",
    server: {
      host: "::",
      port: 8080,
      hmr: { overlay: false },
    },
    plugins,
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          // Split vendor chunks to reduce initial bundle size
          manualChunks: {
            vendor: ["react", "react-dom", "react-router-dom"],
            supabase: ["@supabase/supabase-js"],
          },
        },
      },
    },
  };
});
