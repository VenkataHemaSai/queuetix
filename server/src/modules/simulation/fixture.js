import { createHash, randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { layoutSeats } from "../../../../shared/seat-layout.js";
import { createQueueRuntime } from "../queue/index.js";
import { createFakeClock } from "../../lib/clock.js";
import { assertSimulationStore } from "./scope.js";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function simulationRuntime(models, connection, clock) {
  return createQueueRuntime({
    ...models,
    connection,
    clock,
    simulation: true,
    paymentProvider: "mock",
    qrHmacSecret: randomUUID(),
  });
}
export async function seedFixture(
  models,
  config,
  runId,
  eventId = new Types.ObjectId(),
  salt = config.seed,
  clock = createFakeClock("2030-01-01T00:00:00Z"),
  checkpoint,
) {
  assertSimulationStore(models);
  const { seats, users, columns, aisleAfter, maxActive } = config;
  const rowCount = Math.ceil(seats / columns);
  const rows = Array.from({ length: rowCount }, (_, n) => "R" + (n + 1) + "-");
  const layout = {
    type: "cinema",
    stage: "Screen",
    tierPrices: { standard: 10000 },
    sections: [
      {
        id: "main",
        prefix: "",
        rows,
        seatsPerRow: columns,
        aisleAfter: [aisleAfter],
        tiers: rows.map(() => "standard"),
      },
    ],
  };
  const event = await models.Event.create({
    _id: eventId,
    organizerId: eventId,
    title: "Simulation fixture",
    description: "Isolated booking proof",
    venue: "Simulation",
    type: "cinema",
    layout,
    timeZone: "UTC",
    currency: "INR",
    status: "lobby_open",
    isSimulation: true,
    simRunId: runId,
    totalSeats: seats,
    maxSeatsPerUser: config.perUser,
    maxActive,
    lobbyOpensAt: clock.now(),
    saleStartsAt: new Date(+clock.now() + 1000),
    startsAt: new Date(+clock.now() + 365 * 86400000),
    shuffleSeed: digest(config.seed).slice(0, 32),
  });
  await checkpoint?.();
  await models.Seat.insertMany(
    layoutSeats(layout)
      .slice(0, seats)
      .map((s) => ({ ...s, eventId })),
  );
  const ids = [];
  for (let first = 0; first < users; first += 100) {
    await checkpoint?.();
    const docs = Array.from(
      { length: Math.min(100, users - first) },
      (_, i) => {
        const n = first + i + 1;
        const id = new Types.ObjectId(digest(salt + ":" + n).slice(0, 24));
        ids.push(id);
        return {
          _id: id,
          email: "bot-" + runId + "-" + n + "@sim.invalid",
          name: "Simulation attendee " + n,
          isBot: true,
          simRunId: runId,
        };
      },
    );
    await models.User.insertMany(docs);
  }
  return { clock, event, ids };
}
export async function pool(items, limit, work) {
  let next = 0,
    failure;
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !failure) {
        const index = next++;
        try {
          results[index] = await work(items[index], index);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return results;
}
export function latency(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  const p = (f) =>
    ordered.length
      ? Number(ordered[Math.ceil(f * ordered.length) - 1].toFixed(2))
      : null;
  return { samples: ordered.length, p50Ms: p(0.5), p95Ms: p(0.95) };
}
