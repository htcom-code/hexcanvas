// Publishes the five packages to a throwaway registry and installs them the way a
// consumer would.
//
// `check-publish.mjs` reads the tarballs; this runs them. The difference is everything
// that only a resolver can answer: whether the `exports` map hands a consumer the right
// file, whether the bindings find `@hexcanvas/core` *from the registry* rather than from
// a workspace link that will not exist on anyone else's machine, whether the published
// `.d.ts` type-checks under a consumer's `moduleResolution`, and whether a bundler can
// follow the import graph to the end.
//
// It runs before `npm publish`, not after. A version number on npmjs.com can never be
// reused — unpublishing frees nothing — so the only place a failing check can still
// change the outcome is here, against a registry that is deleted when the job ends.
//
// Usage: node scripts/verify-registry.mjs [--registry http://localhost:4873]
//        pnpm verify:registry            (assumes verdaccio is already listening)

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const registry = argumentValue("--registry") ?? process.env.VERIFY_REGISTRY ?? "http://localhost:4873";
const packages = ["@hexcanvas/core", "@hexcanvas/element", "@hexcanvas/react", "@hexcanvas/vue", "@hexcanvas/svelte"];

const failures = [];
const fail = (check, detail) => {
  failures.push(`${check}: ${detail}`);
  console.error(`  ✗ ${check} — ${detail}`);
};
const pass = (check, detail = "") => console.log(`  ✓ ${check}${detail ? ` — ${detail}` : ""}`);

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(1);
  }
  return result;
}

// ── the registry ────────────────────────────────────────────────────────────────

// A container takes a moment to start listening, and the job that starts it does not
// wait. Ten seconds is generous for a process that is ready in about one.
async function waitForRegistry() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${registry}/-/ping`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  console.error(`no registry answering at ${registry} after 10s`);
  process.exit(1);
}

// verdaccio's stock configuration lets anyone publish once they have an account, and
// lets anyone create one. That is the whole point of a registry that lives for the
// length of one job: no credential to store, and nothing to leak if the job logs are
// public.
async function register() {
  const user = "hexcanvas-ci";
  const response = await fetch(`${registry}/-/user/org.couchdb.user:${user}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: user, password: "hexcanvas-ci", email: "ci@example.invalid" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.token) {
    console.error(`could not obtain a token from ${registry}: ${response.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  return body.token;
}

// ── the consumer ────────────────────────────────────────────────────────────────

const versions = Object.fromEntries(
  packages.map((name) => {
    const directory = name.replace("@hexcanvas/", "");
    return [name, JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8")).version];
  }),
);

const version = versions["@hexcanvas/core"];

/**
 * Imports every package and uses a symbol from each, so a missing export is a
 * compile error rather than something a consumer discovers at runtime. The React and
 * Vue components are referenced by type only — mounting them needs a DOM, which is
 * what the browser suite is for.
 */
const consumerSource = `
import { createLayout, MemoryByteSource, resolveKeymap } from "@hexcanvas/core";
import type { HexTheme, VisibleRows } from "@hexcanvas/core";
import { HexCanvasElement } from "@hexcanvas/element";
import { HexEditor } from "@hexcanvas/react";
import { HexEditor as HexEditorVue } from "@hexcanvas/vue";
import { hexEditor } from "@hexcanvas/svelte";

const layout = createLayout({ byteLength: 256, bytesPerRow: 16 });
const source = new MemoryByteSource(new Uint8Array(256));
const keymap = resolveKeymap("mac");

export const surface: {
  width: number;
  length: number;
  bindings: number;
  element: typeof HexCanvasElement;
  react: typeof HexEditor;
  vue: typeof HexEditorVue;
  svelte: typeof hexEditor;
  theme: HexTheme | undefined;
  rows: VisibleRows | undefined;
} = {
  width: layout.width,
  length: source.length,
  bindings: keymap.bindings.length,
  element: HexCanvasElement,
  react: HexEditor,
  vue: HexEditorVue,
  svelte: hexEditor,
  theme: undefined,
  rows: undefined,
};
`;

// Two resolutions, because they disagree about published packages in ways nothing in
// this repository would notice. `bundler` is what a Vite or webpack consumer gets;
// `node16` is stricter — it reads the `exports` map the way Node does and rejects a
// package whose types are reachable under one condition but not the other.
const tsconfig = (moduleResolution) => ({
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: "es2022",
    module: moduleResolution === "node16" ? "node16" : "esnext",
    moduleResolution,
    jsx: "react-jsx",
    lib: ["es2022", "dom"],
    types: [],
  },
  include: ["consumer.ts"],
});

function buildConsumer(token) {
  const directory = mkdtempSync(join(tmpdir(), "hexcanvas-consumer-"));

  // Outside the workspace on purpose. Inside it, pnpm would link the packages from
  // packages/*/ and the whole exercise would prove nothing.
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "hexcanvas-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries(packages.map((name) => [name, versions[name]])),
          // The peers the bindings declare. A consumer installs these itself, and the
          // published `.d.ts` files are checked against them here.
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          vue: "^3.4.0",
        },
        devDependencies: {
          "@types/react": "^19.0.0",
          esbuild: "^0.27.0",
          typescript: "^7.0.0",
        },
      },
      null,
      2,
    )}\n`,
  );

  // The registry line points at verdaccio, which proxies npmjs for react and the rest,
  // so the install exercises the published tarballs and nothing else changes.
  writeFileSync(join(directory, ".npmrc"), `registry=${registry}/\n${registry.replace(/^https?:/, "")}/:_authToken=${token}\n`);
  writeFileSync(join(directory, "consumer.ts"), consumerSource.trimStart());
  writeFileSync(join(directory, "tsconfig.bundler.json"), `${JSON.stringify(tsconfig("bundler"), null, 2)}\n`);
  writeFileSync(join(directory, "tsconfig.node16.json"), `${JSON.stringify(tsconfig("node16"), null, 2)}\n`);
  return directory;
}

// ── the checks ──────────────────────────────────────────────────────────────────

/**
 * The dependency ranges a consumer actually received. pnpm rewrites `workspace:*` as it
 * packs, and `check-publish.mjs` confirms that in the tarball — but a rewritten range is
 * only useful if it resolves, and that answer comes from the registry. A binding whose
 * `@hexcanvas/core` resolved to nothing would fail to install rather than fail here.
 */
function checkResolvedDependencies(consumer) {
  for (const name of packages) {
    const manifest = join(consumer, "node_modules", name, "package.json");
    let packed;
    try {
      packed = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      fail("install", `${name} is not in node_modules — it did not install from the registry`);
      continue;
    }
    if (packed.version !== versions[name]) {
      fail("install", `${name} resolved to ${packed.version}, expected ${versions[name]}`);
    }
    for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
      if (String(range).includes("workspace:") || String(range).startsWith("link:") || String(range).startsWith("file:")) {
        fail("install", `${name} depends on ${dependency}@${range} — that range only exists in this checkout`);
      }
    }
  }
  if (failures.length === 0) pass("installed from the registry", `${packages.length} packages at ${version}`);
}

/**
 * The one package that runs outside a browser. The four bindings register custom
 * elements when they load, so importing them in bare node would fail on `HTMLElement`
 * rather than on anything about the release — they are covered by the type check and
 * the bundle instead.
 */
function checkRuntimeImport(consumer) {
  const probe = join(consumer, "probe.mjs");
  writeFileSync(
    probe,
    [
      `import { createLayout, MemoryByteSource } from "@hexcanvas/core";`,
      `const layout = createLayout({ byteLength: 256, bytesPerRow: 16 });`,
      `const source = new MemoryByteSource(new Uint8Array(256));`,
      `if (!(layout.width > 0)) throw new Error("createLayout returned no width");`,
      `if (source.length !== 256) throw new Error("MemoryByteSource lost its bytes");`,
      `console.log("ok");`,
      "",
    ].join("\n"),
  );
  const result = run(process.execPath, [probe], { cwd: consumer });
  if (result.status === 0) pass("imports and runs in node", "@hexcanvas/core");
  else fail("runtime import", (result.stderr || result.stdout).trim().split("\n").slice(0, 6).join(" / "));
}

/**
 * These packages are ESM only, and that is a contract rather than an oversight: the
 * `exports` map has no `require` condition. What matters is that a CommonJS consumer
 * gets a named, documented error instead of a half-loaded module, so the failure is
 * asserted rather than assumed.
 */
function checkCommonJsRefusal(consumer) {
  const probe = join(consumer, "probe.cjs");
  writeFileSync(probe, `try { require("@hexcanvas/core"); console.log("LOADED"); } catch (error) { console.log(error.code ?? "NO_CODE"); }\n`);
  const result = run(process.execPath, [probe], { cwd: consumer });
  const outcome = result.stdout.trim();
  const clean = ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM", "ERR_REQUIRE_CYCLE_MODULE"];
  if (clean.includes(outcome)) pass("refuses require() cleanly", outcome);
  else if (outcome === "LOADED") pass("require() interop", "node loaded the ESM entry (node >= 22.12 require(esm))");
  else fail("commonjs", `require() produced ${outcome || "no output"} — neither a clean refusal nor a load`);
}

function checkTypes(consumer, resolution) {
  const result = run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", `tsconfig.${resolution}.json`], { cwd: consumer });
  if (result.status === 0) pass(`types resolve under moduleResolution: ${resolution}`);
  else fail(`types (${resolution})`, (result.stdout || result.stderr).trim().split("\n").slice(0, 8).join(" / "));
}

/**
 * A bundler following every import specifier in the published output to a real file.
 * This is what catches a binding whose `dist` imports a path the tarball does not
 * contain — invisible to a type check, fatal to the first consumer who builds.
 */
function checkBundle(consumer) {
  const entry = join(consumer, "bundle.js");
  writeFileSync(
    entry,
    [
      `import "@hexcanvas/element";`,
      `export { createLayout } from "@hexcanvas/core";`,
      `export { HexEditor } from "@hexcanvas/react";`,
      `export { HexEditor as HexEditorVue } from "@hexcanvas/vue";`,
      `export { hexEditor } from "@hexcanvas/svelte";`,
      "",
    ].join("\n"),
  );
  const result = run(
    join(consumer, "node_modules", ".bin", "esbuild"),
    ["bundle.js", "--bundle", "--format=esm", "--platform=browser", "--outfile=bundle.out.js", "--external:react", "--external:react-dom", "--external:react/jsx-runtime", "--external:vue"],
    { cwd: consumer },
  );
  if (result.status === 0) {
    const size = Math.round(readFileSync(join(consumer, "bundle.out.js")).byteLength / 1024);
    pass("bundles for the browser", `${size} KB from all five`);
  } else {
    fail("bundle", (result.stderr || result.stdout).trim().split("\n").slice(0, 8).join(" / "));
  }
}

// ── the run ─────────────────────────────────────────────────────────────────────

console.log(`registry ${registry}`);
await waitForRegistry();
const token = await register();

const npmrc = join(mkdtempSync(join(tmpdir(), "hexcanvas-npmrc-")), ".npmrc");
writeFileSync(npmrc, `registry=${registry}/\n${registry.replace(/^https?:/, "")}/:_authToken=${token}\n`);
const publishEnv = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc, npm_config_registry: `${registry}/` };

console.log(`\npublishing ${version} to the throwaway registry`);
// `--tag ci`: this registry is gone in a minute, but a tag that is not `latest` keeps
// the command shaped like the real one, where the tag is deliberate.
mustRun("pnpm", ["publish", "-r", "--registry", `${registry}/`, "--tag", "ci", "--access", "public", "--no-git-checks", "--report-summary=false"], {
  cwd: root,
  env: publishEnv,
});

console.log("\ninstalling as a consumer, outside the workspace");
const consumer = buildConsumer(token);
console.log(`  ${consumer}`);
mustRun("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: consumer, env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } });

console.log("\nchecks");
checkResolvedDependencies(consumer);
checkRuntimeImport(consumer);
checkCommonJsRefusal(consumer);
checkTypes(consumer, "bundler");
checkTypes(consumer, "node16");
checkBundle(consumer);

if (process.env.KEEP_CONSUMER !== "1") rmSync(consumer, { recursive: true, force: true });
else console.log(`\nconsumer kept at ${consumer}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed — nothing has been published to npm.`);
  process.exit(1);
}
console.log(`\nall checks passed for ${version} — the tarballs install and build as published.`);
