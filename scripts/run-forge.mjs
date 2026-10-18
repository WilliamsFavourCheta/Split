import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const platformPackage = `@foundry-rs/forge-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
let forge;
try {
  forge = require.resolve(`${platformPackage}/bin/forge${process.platform === "win32" ? ".exe" : ""}`);
} catch {
  console.error(`The optional ${platformPackage} package is required to run Forge on this platform.`);
  process.exit(1);
}

const result = spawnSync(forge, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
