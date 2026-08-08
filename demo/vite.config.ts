import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vue's esm-bundler build asks the bundler to pin these.
  define: { __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
  // The second page uses the custom element with no framework at all.
  build: { rollupOptions: { input: { index: "index.html", element: "element.html", frameworks: "frameworks.html" } } },
});
