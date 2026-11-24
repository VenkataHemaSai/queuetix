import { env, fixture, testDatabase } from "./m4-fixture.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { seedFixture } from "../src/modules/simulation/fixture.js";
import { simulationWorker } from "../src/modules/simulation/admin.js";
import { cleanFixture } from "../src/modules/simulation/service.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  simulationModels,
  createRunManager,
} from "../src/modules/simulation/manager.js";
import { Types } from "mongoose";
let db, models;
beforeAll(async () => {
  db = await testDatabase("qt_proof_admin");
  models = await simulationModels(db.connection);
});
afterAll(async () => {
  await db?.close();
});
test("a durable lock rejects a competing start, cancellation cleans only this run", async () => {
  const main = await db.models.User.create({
    name: "Ordinary attendee",
    email: "ordinary@example.invalid",
  });
  const manager = createRunManager({ connection: db.connection, models });
  const started = await manager.start({ users: 20, seats: 10 });
  await expect(manager.start({ users: 20, seats: 10 })).rejects.toMatchObject({
    status: 409,
  });
  await manager.cancel(started.runId);
  await manager.idle();
  expect(await manager.status()).toMatchObject({
    state: "cancelled",
    cleanup: "complete",
  });
  expect(await db.models.User.exists({ _id: main._id })).toBeTruthy();
  expect(await models.User.countDocuments({ isBot: true })).toBe(0);
});
test("expired ownership is recovered after interruption and an ordinary-looking record survives", async () => {
  const manager = createRunManager({ connection: db.connection, models });
  const eventId = new Types.ObjectId(),
    runId = "interrupted";
  await models.User.create({
    isBot: true,
    simRunId: runId,
    name: "Simulation attendee",
    email: "bot-interrupted-1@sim.invalid",
  });
  await db.connection
    .collection("qt_sim_control")
    .updateOne(
      { _id: "latest" },
      { $set: { runId, eventId, state: "running", leaseUntil: new Date(0) } },
      { upsert: true },
    );
  await manager.maintenance();
  expect(await manager.status()).toMatchObject({
    state: "failed",
    cleanup: "complete",
  });
  expect(await models.User.countDocuments({ simRunId: runId })).toBe(0);
});
test("admin API, real worker, bounded commands and isolated mock settlement", async () => {
  const f = await fixture(db);
  const admin = await f.user("admin"),
    attendee = await f.user();
  const worker = simulationWorker(db.connection.getClient().s.url);
  const app = request(
    createApp({
      clock: f.clock,
      clientOrigins: [],
      features: {
        ...db,
        env: { ...env, paymentProvider: "razorpay", razorpay: {} },
        razorpay: new Proxy(
          {},
          {
            get() {
              throw Error("Simulation reached the gateway");
            },
          },
        ),
        booking: f.booking,
        queue: f.queue,
        simulations: worker,
      },
    }),
  );
  const path = "/operations/simulation";
  try {
    await app.get(path).expect(401);
    for (const actor of [f.owner, attendee])
      await app
        .post(path)
        .set("Authorization", f.auth(actor))
        .send({ users: 2, seats: 2 })
        .expect(403);
    for (const input of [
      { users: 301, seats: 10 },
      { users: 3, seats: 2001 },
      { users: 0, seats: 1 },
    ])
      await app
        .post(path)
        .set("Authorization", f.auth(admin))
        .send(input)
        .expect(400);
    const start = () =>
      app
        .post(path)
        .set("Authorization", f.auth(admin))
        .send({ users: 8, seats: 4 });
    const starts = await Promise.all([start(), start()]);
    expect(starts.map((r) => r.status).sort()).toEqual([202, 409]);
    const deadline = Date.now() + 60000;
    let run,
      checkedVisibility = false;
    do {
      ({
        body: { run },
      } = await app.get(path).set("Authorization", f.auth(admin)).expect(200));
      if (run?.state !== "running") break;
      if (!checkedVisibility && run.progress?.joined > 0) {
        const simulation = await models.Event.findOne({ simRunId: run.runId });
        const publicList = await app.get("/events").expect(200);
        expect(
          publicList.body.events.some((e) => e.id === String(simulation._id)),
        ).toBe(false);
        await app.get("/events/" + simulation._id).expect(404);
        await app
          .get("/operations/events/" + simulation._id)
          .set("Authorization", f.auth(admin))
          .expect(404);
        expect(await db.models.User.countDocuments({ isBot: true })).toBe(0);
        checkedVisibility = true;
      }
      await sleep(250);
    } while (Date.now() < deadline);
    expect(run).toMatchObject({
      state: "completed",
      cleanup: "complete",
      result: { integrity: [], completedUsers: 8 },
    });
    expect(run.traffic.peakPerSecond).toBeLessThanOrEqual(60);
    expect(checkedVisibility).toBe(true);
    const previousToken = f.auth(admin);
    await db.models.User.updateOne(
      { _id: admin._id },
      { $set: { role: "attendee" } },
    );
    await app.get(path).set("Authorization", previousToken).expect(403);
    expect(run.traffic.commands).toBeGreaterThan(60);
    expect(await db.models.GatewayOrder.countDocuments()).toBe(0);
    expect(await db.models.Event.countDocuments({})).toBe(1);
    expect(await db.models.Ticket.countDocuments({})).toBe(0);
    for (const model of Object.values(models))
      expect(await model.countDocuments({})).toBe(0);
  } finally {
    await worker.close();
  }
}, 90000);
test("failed runs clean partial fixtures; daily cleanup targets old run data only", async () => {
  const { event: ordinary } = await fixture(db);
  const config = {
    seats: 4,
    users: 4,
    columns: 4,
    aisleAfter: 2,
    maxActive: 2,
    perUser: 2,
    seed: "old",
  };
  const manager = createRunManager({
    connection: db.connection,
    models,
    execute: async ({ eventId, runId }) => {
      await seedFixture(models, config, runId, eventId, runId);
      throw Error("fixture fault");
    },
  });
  await manager.start({ users: 4, seats: 4 });
  await manager.idle();
  expect(await manager.status()).toMatchObject({
    state: "failed",
    cleanup: "complete",
  });
  const old = await seedFixture(models, config, "orphan", undefined, "orphan");
  const fresh = await seedFixture(models, config, "fresh", undefined, "fresh");
  await expect(cleanFixture(db.models, "orphan", ordinary._id)).rejects.toThrow(
    "ownership mismatch",
  );
  await models.Event.collection.updateOne(
    { _id: old.event._id },
    { $set: { createdAt: new Date(0) } },
  );
  await manager.maintenance();
  expect(await models.Seat.countDocuments({ eventId: old.event._id })).toBe(0);
  expect(await models.User.countDocuments({ simRunId: "orphan" })).toBe(0);
  expect(await models.Seat.countDocuments({ eventId: fresh.event._id })).toBe(
    4,
  );
  expect(await db.models.Event.exists({ _id: ordinary._id })).toBeTruthy();
});
test("daily cleanup skips a leased run even when its fixture is older than one day", async () => {
  const config = {
    seats: 2,
    users: 2,
    columns: 2,
    aisleAfter: 2,
    maxActive: 2,
    perUser: 2,
    seed: "leased",
  };
  const { event } = await seedFixture(
    models,
    config,
    "leased",
    undefined,
    "leased",
  );
  await models.Event.collection.updateOne(
    { _id: event._id },
    { $set: { createdAt: new Date(0) } },
  );
  await models.User.collection.updateMany(
    { simRunId: "leased" },
    { $set: { createdAt: new Date(0) } },
  );
  await db.connection.collection("qt_sim_control").updateOne(
    { _id: "latest" },
    {
      $set: {
        state: "running",
        runId: "leased",
        eventId: event._id,
        leaseUntil: new Date(Date.now() + 60000),
      },
    },
    { upsert: true },
  );
  const manager = createRunManager({ connection: db.connection, models });
  await manager.maintenance();
  expect(await models.User.countDocuments({ simRunId: "leased" })).toBe(2);
  expect(await models.Seat.countDocuments({ eventId: event._id })).toBe(2);
});

test("recovery waits for local work to drain and a late finalizer cannot replace the recovery result", async () => {
  const control = db.connection.collection("qt_sim_control");
  await control.updateOne(
    { _id: "latest" },
    { $set: { leaseUntil: new Date(0) } },
  );
  const recovery = createRunManager({ connection: db.connection, models });
  await recovery.maintenance();
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const manager = createRunManager({
    connection: db.connection,
    models,
    execute: async (context) => {
      await models.User.create({
        isBot: true,
        simRunId: context.runId,
        name: "Paused worker",
        email: "bot-paused@sim.invalid",
      });
      entered.resolve(context);
      await resume.promise;
      return { failures: [] };
    },
  });
  await manager.start({ users: 1, seats: 1 });
  const { eventId, runId, signal } = await entered.promise;
  try {
    await control.updateOne(
      { _id: "latest" },
      { $set: { leaseUntil: new Date(0) } },
    );
    await manager.maintenance();
    expect(signal.aborted).toBe(true);
    expect((await manager.status()).state).toBe("running");
    expect(await models.User.countDocuments({ simRunId: runId })).toBe(1);
    await expect(manager.start({ users: 1, seats: 1 })).rejects.toMatchObject({
      code: "SIMULATION_BUSY",
    });
    await recovery.maintenance();
    await models.Seat.create({
      eventId,
      label: "A1",
      section: "A",
      row: 0,
      col: 0,
      tier: "standard",
      price: 100,
      seatIndex: 0,
    });
  } finally {
    resume.resolve();
    await manager.idle();
  }
  expect(await manager.status()).toMatchObject({
    state: "failed",
    cleanup: "complete",
    message: "The worker stopped before finishing. Run data was removed.",
  });
  expect(await models.Seat.countDocuments({ eventId })).toBe(0);
  expect(await models.User.countDocuments({ simRunId: runId })).toBe(0);
});
