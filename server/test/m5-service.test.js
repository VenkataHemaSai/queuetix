import { readFile } from "node:fs/promises";
import { fixture as ordinaryFixture, testDatabase } from "./m4-fixture.js";
import {
  runService,
  proofFailures,
} from "../src/modules/simulation/service.js";
import { parseOptions, assertDisposable } from "../../scripts/proof/options.js";
import { simulationTarget } from "../src/modules/simulation/scope.js";
const fixture = JSON.parse(
  await readFile(new URL("../../fixtures/small-show.json", import.meta.url)),
);
let db;
beforeAll(async () => {
  db = await testDatabase("qt_proof_test");
});
afterAll(async () => {
  await db?.close();
});
test.each(["greedy-2", "mixed"])(
  "real admission, contention and paid ownership for %s",
  async (profile) => {
    const result = await runService({
      ...db,
      config: { ...fixture, profile, seed: "queue-proof", concurrency: 20 },
    });
    expect(result.failures).toEqual([]);
    expect(result.soldSeats).toBe(40);
    expect(result.completedUsers).toBe(200);
    expect(result.integrity).toEqual([]);
    expect(result.conflicts).toBeGreaterThan(0);
    if (profile === "greedy-2")
      expect(result.terminal).toEqual({ completed: 20, expired_soldout: 180 });
    else {
      expect(result.abandonments).toBeGreaterThan(0);
      expect(result.failedPayments).toBeGreaterThan(0);
    }
  },
  120000,
);
test("rejects unsafe targets, external inputs and invalid limits", () => {
  const render = { NODE_ENV: "production", RENDER: "true" };
  expect(
    simulationTarget("mongodb+srv://example.invalid/tickets_dev", render),
  ).toBeNull();
  expect(
    simulationTarget("mongodb+srv://example.invalid/tickets_prod", {
      NODE_ENV: "production",
    }),
  ).toBeNull();
  expect(
    simulationTarget("mongodb+srv://example.invalid/tickets_prod", render),
  ).toBe("hosted");
  expect(
    simulationTarget("mongodb://127.0.0.1/qt_proof_demo?replicaSet=rs0", {}),
  ).toBe("local");
  for (const uri of [
    "mongodb://localhost/tickets_dev",
    "mongodb+srv://remote/qt_proof_a",
    "mongodb://127.0.0.1/tickets_prod",
  ])
    expect(() => assertDisposable(uri, "qt_proof_a")).toThrow();
  for (const args of [
    ["--uri", "mongodb://remote"],
    ["--mode", "http", "--users", "5000"],
    ["--seats", "0"],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(
    proofFailures({
      integrity: ["bad"],
      terminal: {},
      timeline: [],
      profile: "greedy-2",
    }).length,
  ).toBeGreaterThan(0);
});

test("an event-scoped sweep leaves another event's expired hold and pass untouched", async () => {
  const first = await ordinaryFixture(db);
  const other = await ordinaryFixture(db);
  const firstUser = await first.user();
  const otherUser = await other.user();
  const a = await first.begin(firstUser._id);
  const b = await other.begin(otherUser._id);
  first.clock.advance(601_000);
  await first.sweep(first.event._id);
  expect(await db.models.Hold.findById(a.hold._id)).toMatchObject({
    status: "expired",
  });
  expect(await db.models.Pass.findById(a.order.passId)).toMatchObject({
    status: "expired",
  });
  expect(await db.models.Hold.findById(b.hold._id)).toMatchObject({
    status: "active",
  });
  expect(await db.models.Pass.findById(b.order.passId)).toMatchObject({
    status: "active",
  });
});
