import { writeFile } from "node:fs/promises";
import os from "node:os";
import { parseOptions } from "./proof/options.js";
import { withDisposable } from "./proof/database.js";
import { runService } from "../server/src/modules/simulation/service.js";
try {
  const { output, ...config } = parseOptions(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const run =
    config.mode === "http"
      ? (await import("./proof/http.js")).runHttp
      : runService;
  const result = await withDisposable((db) => run({ ...db, config }));
  const evidence = {
    startedAt,
    node: process.version,
    platform: os.platform(),
    cpu: os.cpus()[0]?.model,
    database: "MongoMemoryReplSet 7.0.24",
    config,
    result,
  };
  const json = JSON.stringify(evidence, null, 2) + "\n";
  if (output) await writeFile(output, json, { flag: "wx" });
  console.log(json);
  if (result.failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error.code ?? error.name, error.message);
  process.exitCode = 1;
}
