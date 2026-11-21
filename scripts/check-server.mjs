import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../server/src/", import.meta.url));
for (const path of readdirSync(source, { recursive: true })) {
  if (!path.endsWith(".js")) continue;
  const result = spawnSync(process.execPath, ["--check", path], {
    cwd: source,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(1);
}
