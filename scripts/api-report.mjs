// The public surface of all five packages, written down and checked.
//
// `pnpm api` verifies the committed report still matches what the build emits;
// `pnpm api:update` rewrites it. A change to the report in a diff is a change to
// what consumers can see, which is the one kind of change that cannot be taken
// back after a release.
//
// API Extractor is invoked as a library rather than through its CLI so this can
// run all five in one process and report them together. It carries its own
// TypeScript (5.9) and reads the emitted .d.ts, so it is unaffected by the
// version the repository builds with.
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const local = process.argv.includes("--local");
const root = new URL("..", import.meta.url).pathname;

const packages = readdirSync(join(root, "packages")).filter((dir) =>
  readdirSync(join(root, "packages", dir)).includes("api-extractor.json"),
);

let failed = 0;
for (const pkg of packages) {
  const config = ExtractorConfig.loadFileAndPrepare(join(root, "packages", pkg, "api-extractor.json"));
  const result = Extractor.invoke(config, {
    localBuild: local,
    showVerboseMessages: false,
    messageCallback: (message) => {
      // Reported below through the result, and the raw stream is noisy.
      if (message.messageId === "console-api-report-not-copied") message.handled = true;
    },
  });

  const status = result.succeeded ? "ok" : "FAILED";
  const detail = result.apiReportChanged
    ? local
      ? "report updated"
      : "report differs from the committed one — run `pnpm api:update` and review the diff"
    : "unchanged";
  console.log(`${status.padEnd(7)} @hexcanvas/${pkg.padEnd(8)} ${detail}`);

  if (!result.succeeded) failed += 1;
  rmSync(join(root, "packages", pkg, "temp"), { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed. Errors above are one of two kinds:`);
  console.error("  - the report changed: the public API moved. Update it and say why in the pull request.");
  console.error("  - ae-forgotten-export: a type the API names but does not export, so a consumer cannot write it down.");
  process.exit(1);
}
console.log(`\nAll ${packages.length} API reports match.`);
