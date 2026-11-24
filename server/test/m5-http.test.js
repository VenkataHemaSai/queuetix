import { withDisposable } from "../../scripts/proof/database.js";
import { parseOptions } from "../../scripts/proof/options.js";
import { runHttp } from "../../scripts/proof/http.js";
test("authenticated loopback clients observe the join limit, reconnect SSE and pay", async () => {
  const config = parseOptions([
    "--mode",
    "http",
    "--users",
    "8",
    "--streams",
    "3",
    "--seats",
    "10",
  ]);
  const r = await withDisposable((db) => runHttp({ ...db, config }));
  expect(r).toMatchObject({
    completedUsers: 8,
    peakStreams: 3,
    connectionFailures: 0,
    reconnections: 1,
    expected429: 3,
    buyers: 5,
    tickets: 10,
    failedPayments: 1,
    failures: [],
  });
}, 60000);
