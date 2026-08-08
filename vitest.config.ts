import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}/src/index.ts`, import.meta.url));

/**
 * Bindings import each other by package name, which would resolve to `dist` and
 * make every browser run depend on a fresh build. Pointing the names at `src`
 * keeps the suite honest about the working tree instead.
 */
const alias = {
  "@hexcanvas/core": source("core"),
  "@hexcanvas/element": source("element"),
  "@hexcanvas/react": source("react"),
  "@hexcanvas/vue": source("vue"),
  "@hexcanvas/svelte": source("svelte"),
};

export default defineConfig({
  test: {
    projects: [
      {
        // Logic that needs no DOM. Fast, and the only project CI's alpine image runs.
        test: {
          name: "core",
          include: ["packages/*/test/**/*.test.ts"],
          benchmark: { include: ["packages/*/bench/**/*.bench.ts"] },
          environment: "node",
        },
      },
      {
        resolve: { alias },
        // Named up front: discovering them mid-run reloads the page and vitest
        // warns that the reload can make a test flake.
        optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "vue"] },
        test: {
          name: "browser",
          // `.tsx` as well, because the playground is a React app and the tests
          // that keep it honest mount it rather than poking at its DOM.
          include: ["test/browser/**/*.test.ts", "test/browser/**/*.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
