import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * The client-contract suite runs against the BUILT artifact (lib/client.js),
 * so a missing build must produce artifacts here — never a silently skipped
 * suite.
 */
export default function globalSetup(): void {
  if (existsSync("lib/index.js") && existsSync("lib/client.js")) return;
  const result = spawnSync(process.execPath, ["node_modules/tsdown/dist/run.mjs"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("artifact tests need lib/ and the tsdown build failed — run pnpm build");
  }
}
