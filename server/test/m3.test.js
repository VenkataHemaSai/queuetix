import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { createFakeClock } from "../src/lib/clock.js";
import { connectMongo } from "../src/lib/db.js";
import { createApp } from "../src/app.js";
import { initializeModels } from "../src/modules/models.js";
import { createQueueRuntime } from "../src/modules/queue/index.js";
import { buildLayout, layoutSeats } from "../../shared/seat-layout.js";

const env = {
  nodeEnv: "test",
  jwtSecret: "fixture-queue-session-key-local-only",
  paymentWebhookSecret: "fixture-queue-payment-key-local-only",
  qrHmacSecret: "fixture-queue-ticket-key-local-only",
};
const id = () => new mongoose.Types.ObjectId();
const layout = buildLayout("bus", { standard: 20000 });
const epoch = new Date("2027-01-01T12:00:00Z").getTime();
let cluster, connection, models;
beforeAll(async () => {
  cluster = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  connection = await connectMongo(cluster.getUri("tickets_m3_test"));
  models = await initializeModels(connection);
});
afterAll(async () => {
  await connection?.close();
  await cluster?.stop();
});
async function fixture(
  fields = {},
  count = 40,
  scope = { models, connection },
) {
  const { models, connection } = scope;
  const clock = createFakeClock(epoch);
  const runtime = (options = {}) =>
    createQueueRuntime({ ...models, connection, clock, ...env, ...options });
  const event = await models.Event.create({
    organizerId: id(),
    title: "Queue fixture",
    description: "Disposable local test",
    venue: "Test site",
    type: "bus",
    layout,
    timeZone: "UTC",
    currency: "INR",
    status: "on_sale",
    saleStartsAt: new Date(epoch - 1000),
    lobbyOpensAt: new Date(epoch - 600000),
    startsAt: new Date(epoch + 86400000),
    nextNumber: 1,
    totalSeats: count,
    ...fields,
  });
  const eventId = event._id;
  const specs = layoutSeats(layout);
  const seats = await models.Seat.insertMany(
    Array.from({ length: count }, (_, index) => ({
      ...specs[index % specs.length],
      seatIndex: index,
      label: `S${index + 1}`,
      eventId,
    })),
  );
  return {
    ...runtime(),
    runtime,
    clock,
    eventId,
    seats,
    event: () => models.Event.findById(eventId).lean(),
    entries: () => models.QueueEntry.find({ eventId }).sort("number").lean(),
    entry: (userId) => models.QueueEntry.findOne({ eventId, userId }).lean(),
  };
}
const code = (promise, name) =>
  expect(promise).rejects.toMatchObject({ code: name });
const bad = (f) => f.booking.verifyEventIntegrity(f.eventId);

test("T-OPEN-1 T-OPEN-FREEZE-1 T-OPEN-FREEZE-3 committed lobby joins and competing openers agree on the frozen count", async () => {
  const f = await fixture({ status: "lobby_open", nextNumber: null });
  const early = Array.from({ length: 100 }, id);
  await Promise.all(early.map((user) => f.queue.join(f.eventId, user)));
  const late = Array.from({ length: 20 }, id);
  const joining = late.map((user) => f.queue.join(f.eventId, user));
  const results = await Promise.allSettled([
    ...joining,
    f.queue.checkSchedule(),
    f.queue.checkSchedule(),
  ]);
  for (const result of results)
    if (result.status === "rejected")
      expect(result.reason.code).toBe("SALE_OPENING");
  for (const user of late) await f.queue.join(f.eventId, user);
  const event = await f.event();
  const entries = await f.entries();
  expect(event.status).toBe("on_sale");
  expect(event.lobbyCount).toBe(
    entries.filter((entry) => entry.joinedInLobby).length,
  );
  expect(entries.map((entry) => entry.number)).toEqual(
    Array.from({ length: 120 }, (_, index) => index + 1),
  );
  expect(event.nextNumber).toBe(121);
  expect(await bad(f)).toEqual([]);
});

test("T-OPEN-2 T-REJOIN-API-1 duplicate late joins allocate only one number", async () => {
  const f = await fixture();
  const user = id();
  const entries = await Promise.all(
    Array.from({ length: 5 }, () => f.queue.join(f.eventId, user)),
  );
  expect(entries.map((entry) => entry.number)).toEqual([1, 1, 1, 1, 1]);
  expect(await f.event()).toMatchObject({ nextNumber: 2 });
  expect(await bad(f)).toEqual([]);
});

test("T-OPEN-3 T-OPEN-4 T-OPEN-FREEZE-2 T-OPEN-RETRY interrupted numbering recovers the stored seed", async () => {
  const f = await fixture({
    status: "lobby_open",
    saleStartsAt: new Date(epoch + 1000),
    nextNumber: null,
    shuffleSeed: "1".repeat(32),
    lobbyJoinCount: 502,
  });
  const users = Array.from({ length: 502 }, id);
  await models.QueueEntry.insertMany(
    users.map((userId) => ({
      eventId: f.eventId,
      userId,
      status: "lobby",
      joinedInLobby: true,
      joinedAt: f.clock.now(),
    })),
  );
  f.clock.advance(1000);
  const bulk = models.QueueEntry.bulkWrite.bind(models.QueueEntry);
  const spy = jest
    .spyOn(models.QueueEntry, "bulkWrite")
    .mockImplementationOnce(bulk)
    .mockRejectedValueOnce(new Error("fixture interruption"));
  try {
    await expect(f.queue.finishOpening(f.eventId)).rejects.toThrow(
      "fixture interruption",
    );
  } finally {
    spy.mockRestore();
  }
  expect(await f.event()).toMatchObject({
    status: "opening",
    lobbyCount: users.length,
    shuffleSeed: "1".repeat(32),
  });
  expect((await f.entries()).filter((x) => x.number != null)).toHaveLength(500);
  await f.runtime().recover();
  const numbered = await f.entries();
  const { createHash } = await import("node:crypto");
  const rank = (seed) =>
    users.map(String).sort((a, b) => {
      const hash = (user) =>
        createHash("sha256")
          .update(seed + ":" + user)
          .digest("hex");
      return hash(a).localeCompare(hash(b)) || a.localeCompare(b);
    });
  expect(numbered.map((x) => String(x.userId))).toEqual(rank("1".repeat(32)));
  expect(numbered.map((x) => String(x.userId))).not.toEqual(
    rank("2".repeat(32)),
  );
  await f.runtime().recover();
  expect(await f.entries()).toEqual(numbered);
  expect(await f.event()).toMatchObject({ status: "on_sale", nextNumber: 503 });
  expect(await bad(f)).toEqual([]);
});

test("T-OPEN-FREEZE-4 T-OPEN-FREEZE-5 inconsistent frozen membership remains closed and is reported", async () => {
  const f = await fixture({
    status: "opening",
    lobbyCount: 2,
    shuffleSeed: "1".repeat(32),
    nextNumber: null,
  });
  await expect(f.queue.finishOpening(f.eventId)).rejects.toMatchObject({
    code: "QUEUE_INTEGRITY",
  });
  expect(await f.event()).toMatchObject({
    status: "opening",
    nextNumber: null,
  });
  expect(await f.entries()).toEqual([]);
});

test("T-LOBBY-OPEN-1 T-LOBBY-COLD-1 scheduler opens a lobby once and catches up overdue sales", async () => {
  const f = await fixture({
    status: "scheduled",
    saleStartsAt: new Date(epoch + 1000),
    nextNumber: null,
  });
  await Promise.all([f.queue.checkSchedule(), f.queue.checkSchedule()]);
  expect(await f.event()).toMatchObject({
    status: "lobby_open",
    lobbyJoinCount: 0,
  });
  f.clock.advance(1000);
  await f.runtime().recover();
  expect(await f.event()).toMatchObject({
    status: "on_sale",
    lobbyCount: 0,
    nextNumber: 1,
  });
  expect(await bad(f)).toEqual([]);
});

test("T-LOBBY-COLD-2 startup catches up both missed opening transitions", async () => {
  const f = await fixture({ status: "scheduled", nextNumber: null });
  await f.recover();
  expect(await f.event()).toMatchObject({
    status: "on_sale",
    lobbyCount: 0,
    nextNumber: 1,
  });
  expect(await f.entries()).toEqual([]);
  expect(await bad(f)).toEqual([]);
});

test("recovery isolates a historical event with missing inventory", async () => {
  const f = await fixture({ totalSeats: 120, nextNumber: null }, 0);
  const before = await f.event();
  await f.recover();
  expect(await f.event()).toEqual(before);
  expect(await f.queue.metrics(f.eventId)).toMatchObject({
    seatsRemaining: null,
  });
  expect(await bad(f)).toContain(
    "Seat counts do not match the event inventory.",
  );
  expect(await models.Pass.countDocuments({ eventId: f.eventId })).toBe(0);
});

test("idle queue ticks avoid read transactions and report legacy missing inventory once", async () => {
  const isolated = await connectMongo(cluster.getUri("tickets_m3_idle_test"), {
    monitorCommands: true,
  });
  try {
    const scope = {
      models: await initializeModels(isolated),
      connection: isolated,
    };
    const missing = await fixture(
      { nextNumber: null, totalSeats: 120 },
      0,
      scope,
    );
    const idle = await fixture({}, 40, scope);
    const due = await fixture(
      { status: "scheduled", nextNumber: null },
      40,
      scope,
    );
    const report = jest.fn();
    const runtime = idle.runtime({ report });
    const original = await missing.event();
    await runtime.recover();
    expect(await due.event()).toMatchObject({ status: "on_sale" });
    expect(await missing.event()).toEqual(original);
    expect(
      report.mock.calls.filter(
        ([entry]) => entry.eventId === String(missing.eventId),
      ),
    ).toEqual([
      [
        {
          eventId: String(missing.eventId),
          issue: "Seat counts do not match the event inventory.",
        },
      ],
    ]);

    const client = isolated.getClient();
    const commands = [];
    const capture = (event) => commands.push(event);
    client.on("commandStarted", capture);
    try {
      await runtime.tick();
    } finally {
      client.off("commandStarted", capture);
    }
    expect(
      commands.filter((event) =>
        ["commitTransaction", "abortTransaction"].includes(event.commandName),
      ),
    ).toHaveLength(0);
    expect(
      commands.filter(
        (event) =>
          event.commandName === "aggregate" &&
          event.command.aggregate === "seats",
      ),
    ).toHaveLength(2);
    const user = id();
    await runtime.queue.join(due.eventId, user);
    await runtime.tick();
    expect(await due.entry(user)).toMatchObject({ status: "admitted" });
    expect(await missing.event()).toEqual(original);
    expect(
      await scope.models.Seat.countDocuments({ eventId: missing.eventId }),
    ).toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(await runtime.booking.verifyEventIntegrity(due.eventId)).toEqual([]);
  } finally {
    await isolated.close();
  }
});

test("a socket deadline in one periodic sale is reported while the next sale admits", async () => {
  const isolated = await connectMongo(
    cluster.getUri("tickets_m3_timeout_test"),
  );
  try {
    const scoped = await initializeModels(isolated);
    const scope = { models: scoped, connection: isolated };
    const slow = await fixture({}, 40, scope);
    const healthy = await fixture({}, 40, scope);
    const runtime = healthy.runtime();
    const a = id(),
      b = id();
    await runtime.queue.join(slow.eventId, a);
    await runtime.queue.join(healthy.eventId, b);
    const original = scoped.Seat.aggregate.bind(scoped.Seat);
    const timeout = new mongoose.mongo.MongoOperationTimeoutError(
      "Timed out during socket read (2499ms)",
    );
    const report = jest.fn();
    const aggregate = jest
      .spyOn(scoped.Seat, "aggregate")
      .mockImplementation((pipeline, ...args) => {
        if (String(pipeline[0]?.$match?.eventId) === String(slow.eventId))
          return { session: () => Promise.reject(timeout) };
        return original(pipeline, ...args);
      });
    try {
      await expect(runtime.recover()).rejects.toBe(timeout);
      runtime.queue.ping(slow.eventId, a);
      runtime.queue.ping(healthy.eventId, b);
      await runtime.tick(report);
      expect(report).toHaveBeenCalledWith(
        timeout,
        expect.objectContaining({
          phase: "sold-out check",
          eventId: String(slow.eventId),
        }),
      );
      expect(await slow.entry(a)).toMatchObject({ status: "waiting" });
      expect(await healthy.entry(b)).toMatchObject({ status: "admitted" });
    } finally {
      aggregate.mockRestore();
    }
    await runtime.tick(report);
    expect(await slow.entry(a)).toMatchObject({ status: "admitted" });
    expect(await scoped.Pass.countDocuments({ eventId: slow.eventId })).toBe(1);
    expect(await scoped.Pass.countDocuments({ eventId: healthy.eventId })).toBe(
      1,
    );
  } finally {
    await isolated.close();
  }
});

test.each(["scheduled", "lobby_open", "opening"])(
  "T-EVENT-MISSED-START-1 recovery closes a missed %s sale without resuming numbering",
  async (status) => {
    const f = await fixture({
      status,
      startsAt: new Date(epoch),
      nextNumber: null,
    });
    await models.QueueEntry.create({
      eventId: f.eventId,
      userId: id(),
      status: "lobby",
      joinedInLobby: true,
      joinedAt: f.clock.now(),
    });
    const entries = await f.entries();
    await f.recover();
    await f.runtime().recover();
    expect(await f.event()).toMatchObject({
      status: "ended",
      nextNumber: null,
    });
    expect(await f.entries()).toEqual(entries);
    await code(f.queue.join(f.eventId, id()), "SALE_CLOSED");
    expect(await models.Pass.countDocuments({ eventId: f.eventId })).toBe(0);
  },
);

test("T-DC-1 T-QUEUE-1 T-PRES-1/2 #12 blocks #13 and #14 until the grace period ends", async () => {
  const f = await fixture({ maxActive: 2, admittedUpTo: 11, nextNumber: 15 });
  const users = Array.from({ length: 14 }, id);
  await models.QueueEntry.insertMany(
    users.map((userId, index) => ({
      eventId: f.eventId,
      userId,
      number: index + 1,
      status: index < 11 ? "abandoned" : "waiting",
      joinedAt: f.clock.now(),
    })),
  );
  const close = f.presence.connect(f.eventId, users[11], f.clock.now());
  close();
  for (let time = 0; time <= 45; time += 15) {
    if (time) f.clock.advance(15000);
    for (const user of users.slice(12)) f.queue.ping(f.eventId, user);
    await f.queue.admit(f.eventId);
    expect(await f.event()).toMatchObject({ admittedUpTo: 11 });
  }
  f.clock.advance(1);
  await f.queue.admit(f.eventId);
  expect((await f.entries()).slice(-3).map((x) => x.status)).toEqual([
    "abandoned",
    "admitted",
    "admitted",
  ]);
  expect(await f.event()).toMatchObject({ admittedUpTo: 14 });
  expect(await bad(f)).toEqual([]);
});

test("T-DC-2/3 T-WATERMARK-RACE-1/2 T-REJOIN-API-2/3 restoration and one-time rejoin serialize", async () => {
  const f = await fixture({ maxActive: 1 });
  const first = id(),
    second = id();
  await f.queue.join(f.eventId, first);
  await f.queue.join(f.eventId, second);
  await models.QueueEntry.updateMany(
    { eventId: f.eventId },
    { $set: { status: "abandoned" } },
  );
  expect((await f.queue.me(f.eventId, first)).entry).toMatchObject({
    status: "waiting",
    number: 1,
    rejoinCount: 0,
  });
  await f.queue.admit(f.eventId);
  expect(await f.event()).toMatchObject({ admittedUpTo: 1 });
  await models.Pass.updateOne(
    { eventId: f.eventId, userId: first },
    { $set: { status: "expired" } },
  );
  f.queue.ping(f.eventId, second);
  await Promise.all([f.queue.admit(f.eventId), f.queue.me(f.eventId, second)]);
  const record = await f.entry(second);
  if (record.status === "abandoned") {
    const results = await Promise.all([
      f.queue.rejoin(f.eventId, second, "retry"),
      f.queue.rejoin(f.eventId, second, "retry"),
    ]);
    expect(results.map((x) => x.number)).toEqual([3, 3]);
    await code(
      f.queue.rejoin(f.eventId, second, "new-attempt"),
      "REJOIN_LIMIT",
    );
  } else {
    expect(record).toMatchObject({ number: 2, rejoinCount: 0 });
  }
  const event = await f.event();
  expect(
    await models.QueueEntry.countDocuments({
      eventId: f.eventId,
      status: "waiting",
      number: { $lte: event.admittedUpTo },
    }),
  ).toBe(0);
});

test("T-PASS-TXN-1 T-PASS-CAP-1 T-PASS-IDEMP-1 overlapping controllers and a partial batch rollback preserve capacity", async () => {
  const f = await fixture({ maxActive: 2 });
  const users = Array.from({ length: 3 }, id);
  for (const user of users) await f.queue.join(f.eventId, user);
  const original = models.Pass.create.bind(models.Pass);
  const spy = jest
    .spyOn(models.Pass, "create")
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("fixture interruption"));
  try {
    await expect(f.queue.admit(f.eventId)).rejects.toThrow(
      "fixture interruption",
    );
  } finally {
    spy.mockRestore();
  }
  expect(await models.Pass.countDocuments({ eventId: f.eventId })).toBe(0);
  expect(await f.event()).toMatchObject({ admittedUpTo: 0 });
  await Promise.all([f.queue.admit(f.eventId), f.queue.admit(f.eventId)]);
  expect((await f.entries()).map((x) => x.status)).toEqual([
    "admitted",
    "admitted",
    "waiting",
  ]);
  expect(await models.Pass.countDocuments({ eventId: f.eventId })).toBe(2);
  expect(await bad(f)).toEqual([]);
});

test("T-PASS-ENTRY-EXPIRE T-PASS-QUOTA-1 T-REC-1C T-OLDPAY-WAIT-1 late payment completes a rejoined waiting entry", async () => {
  const f = await fixture({ passSeconds: 60 });
  const user = id();
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "hold",
  );
  const order = await f.booking.createOrder(f.eventId, user, hold._id, "order");
  f.clock.advance(60000);
  const restart = f.runtime();
  await restart.recover();
  await restart.recover();
  expect(await f.entry(user)).toMatchObject({ status: "expired" });
  expect(await models.Hold.findById(hold._id).lean()).toMatchObject({
    status: "active",
  });
  expect(await models.Order.findById(order._id).lean()).toMatchObject({
    status: "pending",
  });
  expect(
    await models.Quota.findOne({ eventId: f.eventId, userId: user }).lean(),
  ).toMatchObject({ held: 1, bought: 0 });
  await restart.queue.rejoin(f.eventId, user, "again");
  expect(await f.entry(user)).toMatchObject({
    status: "waiting",
    rejoinCount: 1,
    number: 2,
  });
  const paid = await restart.booking.confirmPayment({
    orderId: order._id,
    outcome: "succeeded",
    providerRef: String(id()),
  });
  expect(paid.order).toMatchObject({
    status: "paid",
    holdId: hold._id,
    passId: order.passId,
  });
  expect(await f.entry(user)).toMatchObject({ status: "completed", number: 2 });
  expect(await f.event()).toMatchObject({ admittedUpTo: 1 });
  expect(
    await models.Pass.countDocuments({ eventId: f.eventId, status: "active" }),
  ).toBe(0);
  expect(await bad(f)).toEqual([]);
});

test("T-REC-1 T-REC-1A T-REC-1B T-RESTART-PRES-1 T-RESTART-PRES-2 T-RESTART-PRES-3 T-RESTART-ADMIT restart protects waiting users without admitting ghosts", async () => {
  const f = await fixture({ maxActive: 1 });
  const first = id(),
    second = id(),
    third = id();
  await f.queue.join(f.eventId, first);
  await f.queue.admit(f.eventId);
  await f.queue.join(f.eventId, second);
  await f.queue.join(f.eventId, third);
  const original = await models.Pass.findOne({ eventId: f.eventId }).lean();
  const restart = f.runtime();
  await restart.recover();
  await restart.recover();
  expect(await models.Pass.findOne({ eventId: f.eventId }).lean()).toEqual(
    original,
  );
  await models.Event.updateOne({ _id: f.eventId }, { $set: { maxActive: 2 } });
  restart.queue.ping(f.eventId, third);
  await restart.queue.admit(f.eventId);
  expect(await f.event()).toMatchObject({ admittedUpTo: 1 });
  f.clock.advance(45001);
  restart.queue.ping(f.eventId, third);
  await restart.queue.admit(f.eventId);
  expect((await f.entries()).map((x) => x.status)).toEqual([
    "admitted",
    "abandoned",
    "admitted",
  ]);
  expect(await bad(f)).toEqual([]);
});

test("T-END-CUTOFF-1 T-END-HOLD-1 T-END-PAY-1 T-END-UNRESOLVED-1 cutoff closes joining but preserves settlement", async () => {
  const f = await fixture({ startsAt: new Date(epoch + 1000) });
  const user = id();
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "hold",
  );
  f.clock.advance(1000);
  await code(f.queue.join(f.eventId, id()), "SALE_CLOSED");
  await f.queue.checkSchedule();
  expect(await f.event()).toMatchObject({ status: "on_sale" });
  const order = await f.booking.createOrder(f.eventId, user, hold._id, "order");
  f.clock.advance(900000);
  await f.sweep();
  await f.queue.checkSchedule();
  expect(await f.event()).toMatchObject({ status: "on_sale" });
  await f.booking.confirmPayment({
    orderId: order._id,
    providerRef: String(id()),
    outcome: "succeeded",
  });
  await f.queue.checkSchedule();
  expect(await f.event()).toMatchObject({ status: "ended" });
  expect(await bad(f)).toEqual([]);
});

test("T-NOJUMP-1 queue routes enforce attendee identity and seat streams require a pass", async () => {
  const f = await fixture();
  const app = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: { models, connection, env, booking: f.booking, queue: f.queue },
  });
  const demo = await request(app).post("/auth/demo").expect(200);
  const auth = { Authorization: `Bearer ${demo.body.token}` };
  const base = `/events/${f.eventId}`;
  await request(app).get(`/stream/queue/${f.eventId}`).expect(401);
  await request(app).get(`/stream/seats/${f.eventId}`).set(auth).expect(403);
  await request(app)
    .get(base + "/seats")
    .set(auth)
    .expect(403);
  await request(app)
    .post(base + "/queue/join")
    .set(auth)
    .expect(200);
  const state = await request(app)
    .get(base + "/queue/me")
    .set(auth)
    .expect(200);
  expect(state.body).toMatchObject({
    approximatePosition: 1,
    etaMinutes: null,
    entry: { status: "waiting", number: 1 },
  });
  expect(await bad(f)).toEqual([]);
});

test("T-PRES-1 T-PRES-2 activity boundaries and stale stream closes use the same grace deadline", async () => {
  const f = await fixture();
  const user = id();
  const first = f.presence.connect(f.eventId, user, f.clock.now());
  const second = f.presence.connect(f.eventId, user, f.clock.now());
  const status = () => f.presence.status(f.eventId, user, f.clock.now());
  first();
  expect(status()).toBe("connected");
  f.clock.advance(30_000);
  expect(status()).toBe("connected");
  f.clock.advance(1);
  expect(status()).toBe("protected");
  f.clock.advance(14_999);
  expect(status()).toBe("protected");
  f.clock.advance(1);
  expect(status()).toBe("timed_out");
  second();
  f.queue.ping(f.eventId, user);
  expect(status()).toBe("connected");
  f.clock.advance(15_000);
  f.queue.ping(f.eventId, user);
  expect(status()).toBe("connected");
});

test("T-PRES-2 disconnect sweeper retires an overdue waiter even while admission is full", async () => {
  const f = await fixture({ maxActive: 1 });
  const first = id(),
    waiting = id();
  await f.queue.join(f.eventId, first);
  await f.queue.join(f.eventId, waiting);
  await f.queue.admit(f.eventId);
  f.clock.advance(45_000);
  await f.sweep();
  expect(await f.entry(waiting)).toMatchObject({
    status: "waiting",
    number: 2,
  });
  f.clock.advance(1);
  await f.sweep();
  expect(await f.entry(waiting)).toMatchObject({
    status: "abandoned",
    number: 2,
  });
  expect(await f.event()).toMatchObject({ admittedUpTo: 1 });
  expect((await f.queue.me(f.eventId, waiting)).entry).toMatchObject({
    status: "waiting",
    number: 2,
    rejoinCount: 0,
  });
  expect(await bad(f)).toEqual([]);
});

test("T-SOLD-HELD-1 T-SOLD-EXPIRED-1 temporary holds and reclaimable stock do not signal sold out", async () => {
  const f = await fixture({}, 1);
  const buyer = id();
  await f.booking.issuePass(f.eventId, buyer);
  await f.booking.createHold(f.eventId, buyer, [f.seats[0]._id], "held");
  expect(await f.queue.checkSoldOut(f.eventId)).toBe(false);
  expect(await f.queue.metrics(f.eventId)).toMatchObject({
    seatsRemaining: 0,
    stock: 0,
    hasActiveHolds: true,
  });
  f.clock.advance(300000);
  expect(await f.queue.checkSoldOut(f.eventId)).toBe(false);
  expect(await f.queue.metrics(f.eventId)).toMatchObject({
    seatsRemaining: 0,
    stock: 1,
    hasActiveHolds: false,
  });
  await f.sweep();
  expect(await f.queue.metrics(f.eventId)).toMatchObject({
    seatsRemaining: 1,
    stock: 1,
  });
  expect(await bad(f)).toEqual([]);
});

test("T-SOLD-1 T-SOLD-STATE-1 T-SOLD-STATE-2 T-SOLD-STATE-3 T-SOLD-STATE-4 all 500 seats sold with 5,000 queue entries", async () => {
  const f = await fixture({}, 500);
  for (let index = 0; index < 500; index += 4) {
    const user = id();
    await f.booking.issuePass(f.eventId, user);
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      f.seats.slice(index, index + 4).map((x) => x._id),
      "claim",
    );
    const order = await f.booking.createOrder(
      f.eventId,
      user,
      hold._id,
      "order",
    );
    await f.booking.confirmPayment({
      orderId: order._id,
      providerRef: String(id()),
      outcome: "succeeded",
    });
  }
  const users = Array.from({ length: 5000 }, id);
  const pass = await f.booking.issuePass(f.eventId, users[2]);
  const statuses = ["abandoned", "expired", "admitted", "expired_soldout"];
  await models.QueueEntry.insertMany(
    users.map((userId, index) => ({
      eventId: f.eventId,
      userId,
      number: index + 1,
      status: statuses[index] ?? "waiting",
      joinedAt: f.clock.now(),
      ...(index === 2 && { passId: pass._id }),
    })),
  );
  await models.Event.updateOne(
    { _id: f.eventId },
    { $set: { nextNumber: 5001, admittedUpTo: 3 } },
  );
  const started = +f.clock.now();
  f.clock.advance(1000);
  await f.queue.checkSoldOut(f.eventId);
  await f.runtime().recover();
  expect(+f.clock.now() - started).toBeLessThanOrEqual(5000);
  expect(await f.event()).toMatchObject({ status: "sold_out" });
  expect(
    await models.Seat.countDocuments({ eventId: f.eventId, status: "sold" }),
  ).toBe(500);
  expect(await models.Ticket.countDocuments({ eventId: f.eventId })).toBe(500);
  expect(
    await models.QueueEntry.countDocuments({
      eventId: f.eventId,
      status: "expired_soldout",
    }),
  ).toBe(4998);
  expect(await f.entry(users[0])).toMatchObject({ status: "abandoned" });
  expect(await f.entry(users[1])).toMatchObject({ status: "expired" });
  expect(
    await models.Pass.countDocuments({ eventId: f.eventId, status: "active" }),
  ).toBe(0);
  expect(await bad(f)).toEqual([]);
}, 90_000);

test("T-REC-1D T-SOLD-RECOVERY-1 T-END-SOLD-1 restart finishes sold-out cleanup before ending", async () => {
  const f = await fixture({ startsAt: new Date(epoch + 1000) }, 1);
  const owner = id(),
    waiting = id();
  await f.queue.join(f.eventId, owner);
  await f.queue.join(f.eventId, waiting);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    owner,
    [f.seats[0]._id],
    "hold",
  );
  const order = await f.booking.createOrder(
    f.eventId,
    owner,
    hold._id,
    "order",
  );
  await f.booking.confirmPayment({
    orderId: order._id,
    providerRef: String(id()),
    outcome: "succeeded",
  });
  await models.Event.updateOne(
    { _id: f.eventId },
    { $set: { status: "sold_out" } },
  );
  f.clock.advance(1000);
  await f.runtime().recover();
  expect(await f.event()).toMatchObject({ status: "ended" });
  expect(await f.entry(owner)).toMatchObject({ status: "completed" });
  expect(await f.entry(waiting)).toMatchObject({ status: "expired_soldout" });
  expect(await bad(f)).toEqual([]);
});

async function openStream(origin, path, token, signal) {
  const response = await fetch(origin + path, {
    signal,
    headers: { Authorization: "Bearer " + token },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (message.startsWith(":")) continue;
          const [type, raw] = message.split("\n");
          return { type: type.slice(7), data: JSON.parse(raw.slice(6)) };
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
      }
    },
    close: () => reader.cancel(),
  };
}

async function streamFixture(f, action) {
  const app = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: { models, connection, env, booking: f.booking, queue: f.queue },
  });
  const { body: demo } = await request(app).post("/auth/demo").expect(200);
  const user = demo.user.id;
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const server = app.listen(0, "127.0.0.1");
  const { once } = await import("node:events");
  await once(server, "listening");
  const controller = new AbortController();
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    await action({
      user,
      open: (kind) =>
        openStream(
          origin,
          "/stream/" + kind + "/" + f.eventId,
          demo.token,
          AbortSignal.any([controller.signal, AbortSignal.timeout(9000)]),
        ),
    });
  } finally {
    controller.abort();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

test("T-PASS-4 T-PASS-5 seat SSE snapshots reconcile held seats and close on pass expiry", async () => {
  const f = await fixture({ passSeconds: 60 });
  await streamFixture(f, async ({ user, open }) => {
    const queue = await open("queue");
    expect(await queue.next()).toMatchObject({
      type: "queue",
      data: {
        entry: { status: "admitted" },
        pass: { expiresAt: expect.any(String) },
      },
    });
    const map = await open("seats");
    const snapshot = await map.next();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.data.seats).toHaveLength(40);
    const seatId = f.seats[0]._id;
    const hold = await f.booking.createHold(f.eventId, user, [seatId], "hold");
    expect(await map.next()).toMatchObject({
      type: "seat:held",
      data: {
        seatIds: [String(seatId)],
        seats: expect.arrayContaining([
          expect.objectContaining({
            id: String(seatId),
            mine: true,
            status: "held",
          }),
        ]),
      },
    });
    expect((await queue.next()).data.hold.id).toBe(String(hold._id));
    await map.close();
    const reopened = await open("seats");
    expect(await reopened.next()).toMatchObject({
      type: "snapshot",
      data: {
        seats: expect.arrayContaining([
          expect.objectContaining({ id: String(seatId), mine: true }),
        ]),
      },
    });
    f.clock.advance(60000);
    await f.sweep();
    expect(await reopened.next()).toMatchObject({ type: "pass:expired" });
    expect(await reopened.next()).toBeNull();
    expect(await queue.next()).toMatchObject({
      type: "pass:expired",
      data: { pass: null, entry: { status: "expired" } },
    });
    await code(f.booking.listSeats(f.eventId, user), "PASS_REQUIRED");
    expect((await f.entry(user)).status).toBe("expired");
    expect((await models.Hold.findById(hold._id)).status).toBe("active");
    await queue.close();
    expect(await bad(f)).toEqual([]);
  });
});

test("post-commit order confirmation closes the seat stream and keeps the queue stream current", async () => {
  const f = await fixture();
  await streamFixture(f, async ({ user, open }) => {
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[0]._id],
      "hold",
    );
    const order = await f.booking.createOrder(
      f.eventId,
      user,
      hold._id,
      "order",
    );
    const queue = await open("queue");
    const map = await open("seats");
    expect((await queue.next()).data.order.status).toBe("pending");
    expect((await map.next()).type).toBe("snapshot");
    await f.booking.confirmPayment({
      orderId: order._id,
      outcome: "succeeded",
      providerRef: String(id()),
    });
    expect(await map.next()).toMatchObject({ type: "order:confirmed" });
    expect(await map.next()).toBeNull();
    expect(await queue.next()).toMatchObject({
      type: "order:confirmed",
      data: { order: { status: "paid" }, entry: { status: "completed" } },
    });
    expect(await models.Ticket.countDocuments({ orderId: order._id })).toBe(1);
    expect(await bad(f)).toEqual([]);
    await queue.close();
  });
});

test("seat SSE rejects a snapshot when its pass expires before the first frame", async () => {
  const f = await fixture({ passSeconds: 60 });
  const app = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: { models, connection, env, booking: f.booking, queue: f.queue },
  });
  const { body: demo } = await request(app).post("/auth/demo").expect(200);
  await f.queue.join(f.eventId, demo.user.id);
  await f.queue.admit(f.eventId);
  const list = f.booking.listSeats.bind(f.booking);
  const spy = jest
    .spyOn(f.booking, "listSeats")
    .mockImplementationOnce(async (...args) => {
      const seats = await list(...args);
      f.clock.advance(60000);
      return seats;
    });
  try {
    const response = await request(app)
      .get("/stream/seats/" + f.eventId)
      .set("Authorization", "Bearer " + demo.token)
      .expect(403);
    expect(response.body.error.code).toBe("PASS_REQUIRED");
    expect(response.text).not.toContain("snapshot");
  } finally {
    spy.mockRestore();
  }
});

test("T-PASS-UNSWEPT-1 T-PASS-QUOTA-1 readmission replaces an overdue pass and preserves a live hold quota", async () => {
  const f = await fixture({ passSeconds: 60 });
  const user = id();
  const previous = await f.booking.issuePass(f.eventId, user);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "held",
  );
  await f.queue.join(f.eventId, user);
  f.clock.advance(60_000);
  f.queue.ping(f.eventId, user);
  expect((await models.Pass.findById(previous._id)).status).toBe("active");
  await f.queue.admit(f.eventId);
  const entry = await f.entry(user);
  expect(entry.status).toBe("admitted");
  expect(String(entry.passId)).not.toBe(String(previous._id));
  expect((await models.Pass.findById(previous._id)).status).toBe("expired");
  expect((await models.Hold.findById(hold._id)).status).toBe("active");
  expect(
    await models.Quota.findOne({ eventId: f.eventId, userId: user }).lean(),
  ).toMatchObject({ held: 1, bought: 0 });
  expect(await bad(f)).toEqual([]);
});

test("T-DC-2 T-REJOIN-API-2 T-REJOIN-API-3 a passed entry uses one new number, including concurrent retries", async () => {
  const f = await fixture({ maxActive: 1 });
  const left = id(),
    current = id();
  await f.queue.join(f.eventId, left);
  await f.queue.join(f.eventId, current);
  f.clock.advance(46_000);
  f.queue.ping(f.eventId, current);
  await f.queue.admit(f.eventId);
  const state = await f.queue.me(f.eventId, left);
  expect(state).toMatchObject({
    entry: { status: "abandoned", number: 1 },
    canRejoin: true,
  });
  const retry = () => f.queue.rejoin(f.eventId, left, "same");
  const results = await Promise.all([retry(), retry()]);
  expect(results.map((x) => x.number)).toEqual([3, 3]);
  expect(await f.event()).toMatchObject({ nextNumber: 4, admittedUpTo: 2 });
  expect(await f.entry(left)).toMatchObject({
    number: 3,
    status: "waiting",
    rejoinCount: 1,
  });
  await code(f.queue.rejoin(f.eventId, left, "another"), "REJOIN_LIMIT");
  expect(await bad(f)).toEqual([]);
});

test("T-POS-1 T-POS-REJOIN-1 positions move with the watermark and ETA waits for three admissions", async () => {
  const f = await fixture({ maxActive: 1 });
  const users = Array.from({ length: 4 }, id);
  for (const user of users) await f.queue.join(f.eventId, user);
  const states = [await f.queue.me(f.eventId, users[3])];
  for (const user of users.slice(0, 3)) {
    await f.queue.admit(f.eventId);
    await models.Pass.updateOne(
      { eventId: f.eventId, userId: user },
      { $set: { expiresAt: f.clock.now() } },
    );
    await f.sweep();
    states.push(await f.queue.me(f.eventId, users[3]));
  }
  expect(states.map((x) => x.approximatePosition)).toEqual([4, 3, 2, 1]);
  expect(states.map((x) => x.etaMinutes)).toEqual([null, null, null, 1]);
  await f.queue.admit(f.eventId);
  await models.Pass.updateOne(
    { eventId: f.eventId, userId: users[3] },
    { $set: { expiresAt: f.clock.now() } },
  );
  await f.sweep();
  expect((await f.queue.rejoin(f.eventId, users[3], "rejoin")).number).toBe(5);
  expect(await f.queue.me(f.eventId, users[3])).toMatchObject({
    approximatePosition: 1,
    rejoinCount: 1,
  });
  expect(await bad(f)).toEqual([]);
});

test.each([
  ["T-OLDPAY-ABANDON-1", "abandoned"],
  ["T-OLDPAY-ABANDON-1", "expired"],
  ["T-OLDPAY-SOLDOUT-1 T-SOLD-PENDING-1", "expired_soldout"],
])(
  "%s an older valid payment completes a current %s entry",
  async (_id, status) => {
    const f = await fixture({ passSeconds: 60 });
    const user = id();
    await f.queue.join(f.eventId, user);
    await f.queue.admit(f.eventId);
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[0]._id],
      "hold",
    );
    const order = await f.booking.createOrder(
      f.eventId,
      user,
      hold._id,
      "order",
    );
    f.clock.advance(60_000);
    await f.sweep();
    if (status !== "expired") {
      await f.queue.rejoin(f.eventId, user, "again");
      await models.QueueEntry.updateOne(
        { eventId: f.eventId, userId: user },
        { $set: { status } },
      );
    }
    const result = await f.booking.confirmPayment({
      orderId: order._id,
      providerRef: String(id()),
      outcome: "succeeded",
    });
    expect(result.order).toMatchObject({
      status: "paid",
      holdId: hold._id,
      passId: order.passId,
    });
    expect(await f.entry(user)).toMatchObject({
      status: "completed",
      number: status === "expired" ? 1 : 2,
    });
    expect(await f.event()).toMatchObject({ admittedUpTo: 1 });
    await code(f.queue.rejoin(f.eventId, user, "another"), "ALREADY_BOOKED");
    expect(await bad(f)).toEqual([]);
  },
);

test("T-OLDPAY-RACE-1 T-OLDPAY-RACE-2 T-OLDPAY-WATERMARK-1 payment racing rejoin or readmission leaves no extra rights", async () => {
  for (const race of ["rejoin", "admission"]) {
    const f = await fixture({ passSeconds: 60 });
    const user = id(),
      next = id();
    await f.queue.join(f.eventId, user);
    await f.queue.admit(f.eventId);
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[0]._id],
      "hold",
    );
    const order = await f.booking.createOrder(
      f.eventId,
      user,
      hold._id,
      "order",
    );
    f.clock.advance(60_000);
    await f.sweep();
    if (race === "admission") await f.queue.rejoin(f.eventId, user, "again");
    const [payment, concurrency] = await Promise.allSettled([
      f.booking.confirmPayment({
        orderId: order._id,
        providerRef: String(id()),
        outcome: "succeeded",
      }),
      race === "admission"
        ? f.queue.admit(f.eventId)
        : f.queue.rejoin(f.eventId, user, "again"),
    ]);
    expect(payment).toMatchObject({
      status: "fulfilled",
      value: { order: { status: "paid" } },
    });
    if (concurrency.status === "rejected")
      expect(concurrency.reason.code).toBe("ALREADY_BOOKED");
    expect(await f.entry(user)).toMatchObject({ status: "completed" });
    expect(
      await models.Pass.countDocuments({
        eventId: f.eventId,
        userId: user,
        status: "active",
      }),
    ).toBe(0);
    await f.queue.join(f.eventId, next);
    await f.queue.admit(f.eventId);
    expect(await f.entry(next)).toMatchObject({ status: "admitted" });
    expect(await bad(f)).toEqual([]);
  }
});

test("T-END-RACE-1 T-END-PAY-2 automatic closing waits for a valid callback; actual ending keeps its refund rule", async () => {
  for (const ended of [false, true]) {
    const f = await fixture({ startsAt: new Date(epoch + 1000) }, 1);
    const user = id();
    await f.queue.join(f.eventId, user);
    await f.queue.admit(f.eventId);
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[0]._id],
      "hold",
    );
    const order = await f.booking.createOrder(
      f.eventId,
      user,
      hold._id,
      "order",
    );
    f.clock.advance(900_000);
    await f.sweep();
    if (ended)
      await models.Event.updateOne(
        { _id: f.eventId },
        { $set: { status: "ended" } },
      );
    const [, payment] = await Promise.all([
      f.queue.checkSchedule(),
      f.booking.confirmPayment({
        orderId: order._id,
        providerRef: String(id()),
        outcome: "succeeded",
      }),
    ]);
    expect(payment.order.status).toBe(ended ? "failed" : "paid");
    expect(payment.payment).toMatchObject(
      ended
        ? { status: "refunded", reason: "event_ended" }
        : { status: "processed" },
    );
    await f.queue.checkSchedule();
    expect(await f.event()).toMatchObject({ status: "ended" });
    expect(await bad(f)).toEqual([]);
  }
});

test("T-RESTART-SWEEP repeated restart retires an overdue hold and refunds its quota once", async () => {
  const f = await fixture();
  const user = id();
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "hold",
  );
  f.clock.advance(300_000);
  await f.runtime().recover();
  await f.runtime().recover();
  expect((await models.Hold.findById(hold._id)).status).toBe("expired");
  expect((await models.Seat.findById(f.seats[0]._id)).status).toBe("available");
  expect(
    await models.Quota.findOne({ eventId: f.eventId, userId: user }).lean(),
  ).toMatchObject({ held: 0, bought: 0 });
  expect(
    await models.AuditLog.countDocuments({
      holdId: hold._id,
      action: "hold.expired",
    }),
  ).toBe(1);
  expect(await bad(f)).toEqual([]);
});

test("T-DC-3 T-WATERMARK-RACE-1 recovery restores an unpassed abandoned number", async () => {
  const f = await fixture();
  const user = id();
  await f.queue.join(f.eventId, user);
  await models.QueueEntry.updateOne(
    { eventId: f.eventId, userId: user },
    { $set: { status: "abandoned" } },
  );
  await f.runtime().recover();
  const state = await f.queue.me(f.eventId, user);
  expect(state).toMatchObject({
    entry: { status: "waiting", number: 1, rejoinCount: 0 },
    approximatePosition: 1,
  });
  await f.queue.admit(f.eventId);
  expect(await f.event()).toMatchObject({ admittedUpTo: 1, nextNumber: 2 });
  expect(await f.entry(user)).toMatchObject({ status: "admitted", number: 1 });
  expect(await bad(f)).toEqual([]);
});

test("T-PASS-ENTRY-EXPIRE successful confirmation takes precedence over concurrent expiry", async () => {
  const f = await fixture({ passSeconds: 60 });
  const user = id();
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "hold",
  );
  const order = await f.booking.createOrder(f.eventId, user, hold._id, "order");
  f.clock.advance(60_000);
  const [, result] = await Promise.all([
    f.sweep(),
    f.booking.confirmPayment({
      orderId: order._id,
      outcome: "succeeded",
      providerRef: String(id()),
    }),
  ]);
  expect(result.order.status).toBe("paid");
  await f.sweep();
  expect(await f.entry(user)).toMatchObject({
    status: "completed",
    passId: order.passId,
  });
  expect((await models.Pass.findById(order.passId)).status).toBe("used");
  expect(await bad(f)).toEqual([]);
});

test("T-EVENT-MISSED-START-1 an unexpectedly unsettled interrupted sale stays closed to joins", async () => {
  const f = await fixture({ startsAt: new Date(epoch + 1000) });
  const user = id();
  await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const hold = await f.booking.createHold(
    f.eventId,
    user,
    [f.seats[0]._id],
    "hold",
  );
  const order = await f.booking.createOrder(f.eventId, user, hold._id, "order");
  await models.Event.updateOne(
    { _id: f.eventId },
    { $set: { status: "opening" } },
  );
  f.clock.advance(1000);
  await f.recover();
  expect(await f.event()).toMatchObject({ status: "opening" });
  await code(f.queue.join(f.eventId, id()), "SALE_CLOSED");
  expect((await f.booking.getOrder(order._id, user)).status).toBe("pending");
  const result = await f.booking.confirmPayment({
    orderId: order._id,
    outcome: "succeeded",
    providerRef: String(id()),
  });
  expect(result.order.status).toBe("paid");
  await f.runtime().recover();
  expect(await f.event()).toMatchObject({ status: "ended", nextNumber: 2 });
  expect(await f.entry(user)).toMatchObject({ status: "completed", number: 1 });
  expect(await bad(f)).toEqual([]);
});

test("T-SOLD-ATOMIC-1 concurrent final payments trigger sold out only after both sales", async () => {
  const f = await fixture({ maxActive: 2 }, 2);
  const users = Array.from({ length: 3 }, id);
  for (const user of users) await f.queue.join(f.eventId, user);
  await f.queue.admit(f.eventId);
  const orders = [];
  for (const [index, user] of users.slice(0, 2).entries()) {
    const hold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[index]._id],
      "held",
    );
    orders.push(
      await f.booking.createOrder(f.eventId, user, hold._id, "order"),
    );
  }
  expect(await f.queue.checkSoldOut(f.eventId)).toBe(false);
  await Promise.all([
    ...orders.map((order) =>
      f.booking.confirmPayment({
        orderId: order._id,
        outcome: "succeeded",
        providerRef: String(id()),
      }),
    ),
    f.queue.checkSoldOut(f.eventId),
  ]);
  await f.queue.checkSoldOut(f.eventId);
  expect(await f.event()).toMatchObject({ status: "sold_out" });
  expect((await f.entries()).map((entry) => entry.status)).toEqual([
    "completed",
    "completed",
    "expired_soldout",
  ]);
  expect(await models.Ticket.countDocuments({ eventId: f.eventId })).toBe(2);
  expect(await bad(f)).toEqual([]);
});

test.each([
  ["T-REJOIN-ORDER-1", "new admission without a hold"],
  ["T-REJOIN-ORDER-2", "live newer hold"],
  ["T-REJOIN-ORDER-3", "overdue unswept newer hold"],
  ["T-REJOIN-ORDER-4", "overdue swept newer hold"],
  ["T-REJOIN-ORDER-5", "newer paid order"],
  ["T-REJOIN-ORDER-6 T-REJOIN-API-4", "completed buyer"],
])(
  "%s historic payment with %s preserves original settlement rights",
  async (_label, scenario) => {
    const f = await fixture();
    const user = id();
    await f.queue.join(f.eventId, user);
    await f.queue.admit(f.eventId);
    const oldHold = await f.booking.createHold(
      f.eventId,
      user,
      [f.seats[0]._id],
      "old",
    );
    const old = await f.booking.createOrder(
      f.eventId,
      user,
      oldHold._id,
      "order",
    );
    f.clock.advance(600_001);
    await f.sweep();
    await f.queue.rejoin(f.eventId, user, "again");
    await f.queue.admit(f.eventId);
    const newerPass = (await f.entry(user)).passId;
    const secondOrderPaid = scenario === "newer paid order";
    const liveNewer = scenario === "live newer hold";
    const overdue = scenario.startsWith("overdue");
    if (liveNewer || overdue || secondOrderPaid) {
      const newerHold = await f.booking.createHold(
        f.eventId,
        user,
        [f.seats[1]._id],
        "new",
      );
      if (secondOrderPaid) {
        const order = await f.booking.createOrder(
          f.eventId,
          user,
          newerHold._id,
          "new-order",
        );
        await f.booking.confirmPayment({
          orderId: order._id,
          outcome: "succeeded",
          providerRef: String(id()),
        });
      } else if (!liveNewer) {
        f.clock.advance(300_000);
        if (scenario === "overdue swept newer hold") await f.sweep();
      }
    }
    const result = await f.booking.confirmPayment({
      orderId: old._id,
      outcome: "succeeded",
      providerRef: String(id()),
    });
    expect(result.order).toMatchObject({
      status: liveNewer || secondOrderPaid ? "failed" : "paid",
      holdId: oldHold._id,
      passId: old.passId,
    });
    expect((await models.Pass.findById(newerPass)).status).toBe(
      liveNewer ? "active" : secondOrderPaid ? "used" : "expired",
    );
    expect(await f.entry(user)).toMatchObject({
      number: 2,
      status: liveNewer ? "admitted" : "completed",
    });
    if (!liveNewer)
      await code(f.queue.rejoin(f.eventId, user, "another"), "ALREADY_BOOKED");
    expect(await models.Ticket.countDocuments({ eventId: f.eventId })).toBe(
      liveNewer ? 0 : 1,
    );
    expect(await bad(f)).toEqual([]);
  },
);
