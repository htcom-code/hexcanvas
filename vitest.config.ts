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
            // All three engines. There are only three, and each disagreed about
            // something nothing else here would notice: the same font string measures
            // 7.83px a character on chromium and 8.04px on WebKit; WebKit does not put
            // a `tabindex` element in the tab order unless Full Keyboard Access is on;
            // and Firefox hands back a scroll offset of 10999.65 for the 11000 you
            // assigned, which used to put the wrong row at the top.
            instances: [{ browser: "chromium" }, { browser: "webkit" }, { browser: "firefox" }],
          },
        },
      },
    ],
  },
});
