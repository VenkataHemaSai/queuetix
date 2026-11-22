import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createFakeClock } from "../src/lib/clock.js";
import { connectMongo } from "../src/lib/db.js";
import { initializeModels } from "../src/modules/models.js";
import { createBooking } from "../src/modules/booking/index.js";
import {
  signPayload,
  verifyTicketPayload,
} from "../src/modules/booking/signatures.js";
import { buildLayout, layoutSeats } from "../../shared/seat-layout.js";
import { createEventService } from "../src/modules/events/event.service.js";
import { createEventInput } from "../src/modules/events/event.validation.js";

const id = () => new mongoose.Types.ObjectId();
const env = {
  jwtSecret: "local-m2-fixture-jwt-secret-only-for-tests",
  paymentWebhookSecret: "local-m2-fixture-payment-key-only-for-tests",
  qrHmacSecret: "local-m2-fixture-ticket-key-only-for-tests",
  nodeEnv: "test",
};
const tierPrices = { standard: 19999 };
const layout = buildLayout("bus", tierPrices);
const saleStartsAt = "2026-11-21T12:00:00Z";
const startsAt = "2026-11-24T12:00:00Z";
let cluster, connection, models;

beforeAll(async () => {
  cluster = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  connection = await connectMongo(cluster.getUri("tickets_m2_test"), {
    maxPoolSize: 30,
  });
  models = await initializeModels(connection);
});
afterAll(async () => {
  await connection?.close();
  await cluster?.stop();
});

async function fixture({ count, passSeconds = 600, status = "on_sale" } = {}) {
  const clock = createFakeClock("2026-11-22T12:00:00Z");
  const specs = count
    ? Array.from({ length: count }, (_, seatIndex) => ({
        label: `X${seatIndex + 1}`,
        section: "main",
        row: Math.floor(seatIndex / 20),
        col: seatIndex % 20,
        tier: "standard",
        price: 19999,
        seatIndex,
      }))
    : layoutSeats(layout);
  const event = await models.Event.create({
    organizerId: id(),
    title: "Fixture",
    description: "Booking test",
    venue: "Local",
    type: "bus",
    layout,
    status,
    timeZone: "UTC",
    currency: "INR",
    startsAt,
    saleStartsAt,
    lobbyOpensAt: saleStartsAt,
    totalSeats: specs.length,
    passSeconds,
  });
  const eventId = event._id;
  const seats = await models.Seat.insertMany(
    specs.map((seat) => ({ ...seat, eventId })),
  );
  const booking = createBooking({ ...models, connection, clock, ...env });
  async function admit(user = id()) {
    await booking.issuePass(eventId, user);
    return user;
  }
  const hold = (user, indices, key = String(id())) =>
    booking.createHold(
      eventId,
      user,
      indices.map((i) => seats[i]._id),
      key,
    );
  const change = (user, previous, indices) =>
    booking.replaceHold(
      eventId,
      user,
      previous._id,
      indices.map((i) => seats[i]._id),
    );
  const place = (user, active, key = String(id())) =>
    booking.createOrder(eventId, user, active._id, key);
  const pay = (order, ref = String(id()), outcome = "succeeded") =>
    booking.confirmPayment({
      orderId: String(order._id),
      providerRef: ref,
      outcome,
    });
  const quota = (user, held, bought) =>
    expect(
      models.Quota.findOne({ eventId, userId: user }).lean(),
    ).resolves.toMatchObject({ held, bought });
  const clean = () =>
    expect(booking.verifyEventIntegrity(eventId)).resolves.toEqual([]);
  return {
    clock,
    eventId,
    seats,
    booking,
    admit,
    hold,
    change,
    place,
    pay,
    quota,
    clean,
  };
}

const code = (operation, expected) =>
  expect(operation).rejects.toMatchObject({ code: expected });

test("T-HOLD-1 reclaimed seats survive repeated sweeping and quota refunds once", async () => {
  const f = await fixture();
  const a = await f.admit(),
    b = await f.admit();
  const first = await f.hold(a, [0, 1]);
  f.clock.advance(300_001);
  const next = await f.hold(b, [1, 2]);
  expect(
    await f.booking.verifyEventIntegrity(f.eventId, { preSweep: true }),
  ).toEqual([]);
  for (let i = 0; i < 3; i += 1) await f.booking.sweepExpired();
  expect((await models.Hold.findById(first._id)).status).toBe("expired");
  expect((await models.Seat.findById(f.seats[0]._id)).status).toBe("available");
  for (const index of [1, 2])
    expect((await models.Seat.findById(f.seats[index]._id)).holdId).toEqual(
      next._id,
    );
  await f.quota(a, 0, 0);
  await f.quota(b, 2, 0);
  await f.clean();
});

test("T-HOLD-2 overlapping replace keeps expiry and a conflict leaves the old hold untouched", async () => {
  const f = await fixture();
  const user = await f.admit(),
    other = await f.admit();
  const old = await f.hold(user, [0, 1]);
  await f.hold(other, [3]);
  await code(f.change(user, old, [1, 3]), "SEAT_UNAVAILABLE");
  expect((await models.Hold.findById(old._id)).status).toBe("active");
  expect((await models.Seat.findById(f.seats[0]._id)).holdId).toEqual(old._id);
  await f.quota(user, 2, 0);
  f.clock.advance(1000);
  const next = await f.change(user, old, [1, 2]);
  expect(next.expiresAt).toEqual(old.expiresAt);
  expect((await models.Hold.findById(old._id)).status).toBe("released");
  expect((await models.Seat.findById(f.seats[0]._id)).status).toBe("available");
  for (const index of [1, 2])
    expect((await models.Seat.findById(f.seats[index]._id)).holdId).toEqual(
      next._id,
    );
  await f.quota(user, 2, 0);
  await f.clean();
});

test("T-HOLD-3 twenty parallel requests never give one user more than one hold or four seats", async () => {
  const f = await fixture();
  const user = await f.admit();
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => f.hold(user, [i, 29, 30, 31])),
  );
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    attempts
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.code),
  ).toEqual(Array(19).fill("HOLD_EXISTS"));
  await f.quota(user, 4, 0);
  await f.clean();
});

test("T-HOLD-4 a user's expired hold is retired when creating a new hold", async () => {
  const f = await fixture();
  const user = await f.admit();
  const old = await f.hold(user, [0, 1]);
  f.clock.advance(300_001);
  await f.hold(user, [0]);
  expect((await models.Hold.findById(old._id)).status).toBe("expired");
  await f.quota(user, 1, 0);
  await f.clean();
});

async function seedAdmissions(f, count) {
  const users = Array.from({ length: count }, id);
  const issuedAt = f.clock.now();
  const expiresAt = new Date(issuedAt.getTime() + 600_000);
  await models.Pass.insertMany(
    users.map((userId) => ({
      eventId: f.eventId,
      userId,
      issuedAt,
      expiresAt,
    })),
  );
  await models.Quota.insertMany(
    users.map((userId) => ({ eventId: f.eventId, userId })),
  );
  return users;
}

test("T-HOLD-5 200 concurrent requests for a hot seat have exactly one winner", async () => {
  const f = await fixture();
  const users = await seedAdmissions(f, 200);
  const results = await Promise.allSettled(
    users.map((user) => f.hold(user, [0])),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.code),
  ).toEqual(Array(199).fill("SEAT_UNAVAILABLE"));
  await f.clean();
}, 60_000);

test.each([
  ["T-PAY-A", 600, "unswept"],
  ["T-PAY-B", 600, "swept"],
  ["T-PAY-D", 60, "passExpired"],
  ["T-PAY-CURRENT-1", 600, "active"],
])(
  "%s payment succeeds when the original seats can be sold",
  async (_case, passSeconds, state) => {
    const f = await fixture({ passSeconds });
    const user = await f.admit();
    const hold = await f.hold(user, [0, 1]);
    const order = await f.place(user, hold);
    if (state === "unswept" || state === "swept") f.clock.advance(300_001);
    if (state === "passExpired") f.clock.advance(60_001);
    if (state === "swept" || state === "passExpired")
      await f.booking.sweepExpired();
    expect(await f.pay(order)).toMatchObject({
      order: { status: "paid" },
      payment: { status: "processed" },
    });
    expect((await models.Hold.findById(hold._id)).status).toBe("converted");
    expect((await models.Pass.findById(order.passId)).status).toBe("used");
    expect(await models.Ticket.countDocuments({ orderId: order._id })).toBe(2);
    await f.quota(user, 0, 2);
    await f.clean();
  },
);

test("T-PAY-C late payment refunds after another user takes the seats", async () => {
  const f = await fixture();
  const a = await f.admit(),
    b = await f.admit();
  const old = await f.place(a, await f.hold(a, [0, 1]));
  f.clock.advance(300_001);
  await f.booking.sweepExpired();
  await f.hold(b, [1]);
  expect(await f.pay(old)).toMatchObject({
    order: { status: "failed", failureReason: "seats_unavailable" },
    payment: { status: "refunded" },
  });
  await f.quota(a, 0, 0);
  await f.quota(b, 1, 0);
  await f.clean();
});

test.each(["E1", "E2", "E3"])(
  "T-PAY-%s and T-PAY-OLDPASS-1 use the exact order pass",
  async (variant) => {
    const f = await fixture();
    const user = await f.admit();
    const old = await f.place(user, await f.hold(user, [0, 1]));
    f.clock.advance(600_001);
    await f.booking.sweepExpired();
    const later = await f.booking.issuePass(f.eventId, user);
    if (variant !== "E3") {
      const newer = await f.hold(user, [2]);
      if (variant === "E2") await f.pay(await f.place(user, newer));
    }
    const result = await f.pay(old);
    if (variant === "E3") {
      expect(result.order.status).toBe("paid");
      expect((await models.Pass.findById(old.passId)).status).toBe("used");
      expect((await models.Pass.findById(later._id)).status).toBe("expired");
      await f.quota(user, 0, 2);
      await code(f.booking.issuePass(f.eventId, user), "ALREADY_BOOKED");
    } else {
      expect(result).toMatchObject({
        order: { status: "failed" },
        payment: { status: "refunded" },
      });
      if (variant === "E1")
        expect(result.order.failureReason).toBe("superseded");
      expect((await models.Pass.findById(later._id)).status).toBe(
        variant === "E1" ? "active" : "used",
      );
      await f.quota(user, variant === "E1" ? 1 : 0, variant === "E2" ? 1 : 0);
    }
    await f.clean();
  },
);

async function oldOrderWithNewerHold(f) {
  const user = await f.admit();
  const order = await f.place(user, await f.hold(user, [0, 1]));
  f.clock.advance(600_001);
  await f.booking.sweepExpired();
  const laterPass = await f.booking.issuePass(f.eventId, user);
  const newerHold = await f.hold(user, [2, 3]);
  return { user, order, laterPass, newerHold };
}

test.each([
  ["before sweeping", false],
  ["after sweeping", true],
])(
  "late payment succeeds with a newer hold at its expiry %s",
  async (_label, swept) => {
    const f = await fixture();
    const { user, order, laterPass, newerHold } =
      await oldOrderWithNewerHold(f);
    f.clock.advance(newerHold.expiresAt.getTime() - f.clock.now().getTime());
    const other = await f.admit();
    const reclaimed = await f.hold(other, [2]);
    if (swept) await f.booking.sweepExpired();
    expect((await models.Hold.findById(newerHold._id)).status).toBe(
      swept ? "expired" : "active",
    );
    await f.quota(user, swept ? 0 : 2, 0);

    const ref = String(id());
    const result = await f.pay(order, ref);
    expect(result).toMatchObject({
      order: { _id: order._id, status: "paid" },
      payment: { status: "processed" },
    });
    await f.booking.sweepExpired();
    expect(await f.pay(order, ref)).toMatchObject(result);
    expect((await models.Hold.findById(order.holdId)).status).toBe("converted");
    expect((await models.Hold.findById(newerHold._id)).status).toBe("expired");
    expect((await models.Pass.findById(order.passId)).status).toBe("used");
    expect((await models.Pass.findById(laterPass._id)).status).toBe("expired");
    expect(await models.Seat.findById(f.seats[2]._id).lean()).toMatchObject({
      status: "held",
      holdId: reclaimed._id,
    });
    expect(await models.Seat.findById(f.seats[3]._id).lean()).toMatchObject({
      status: "available",
      holdId: null,
    });
    await f.quota(user, 0, 2);
    await f.quota(other, 1, 0);
    expect(await models.Payment.countDocuments({ orderId: order._id })).toBe(1);
    expect(
      await models.AuditLog.countDocuments({
        holdId: newerHold._id,
        action: "hold.expired",
      }),
    ).toBe(1);
    const tickets = await models.Ticket.find({ orderId: order._id }).lean();
    expect(tickets).toHaveLength(order.seatIds.length);
    expect(tickets.map(({ seatId }) => seatId)).toEqual(
      expect.arrayContaining(order.seatIds),
    );
    for (const ticket of tickets)
      expect(verifyTicketPayload(ticket.qrPayload, env.qrHmacSecret)).toBe(
        String(ticket._id),
      );
    await f.clean();
  },
);

test("late payment is refunded while a newer hold is still live", async () => {
  const f = await fixture();
  const { user, order, laterPass, newerHold } = await oldOrderWithNewerHold(f);
  f.clock.advance(newerHold.expiresAt.getTime() - f.clock.now().getTime() - 1);
  const result = await f.pay(order, "superseded-ref");
  expect(result).toMatchObject({
    order: { status: "failed", failureReason: "superseded" },
    payment: { status: "refunded", reason: "superseded" },
  });
  expect(await f.pay(order, "superseded-ref")).toMatchObject(result);
  expect((await models.Hold.findById(order.holdId)).status).toBe("expired");
  expect((await models.Hold.findById(newerHold._id)).status).toBe("active");
  expect((await models.Pass.findById(order.passId)).status).toBe("expired");
  expect((await models.Pass.findById(laterPass._id)).status).toBe("active");
  await f.quota(user, 2, 0);
  expect(await models.Ticket.countDocuments({ orderId: order._id })).toBe(0);
  await f.clean();
});

test("T-PAY-F and T-PAY-DOUBLE-1 concurrent distinct callbacks commit one paid result and replay the stored payment", async () => {
  const f = await fixture();
  const user = await f.admit();
  const order = await f.place(user, await f.hold(user, [0, 1]));
  const results = await Promise.all([
    f.pay(order, "ref-f1"),
    f.pay(order, "ref-f2"),
  ]);
  expect(results.map(({ payment }) => payment.status).sort()).toEqual([
    "processed",
    "refunded",
  ]);
  const refunded = results.find(({ payment }) => payment.status === "refunded");
  expect(refunded.payment.reason).toBe("duplicate_payment");
  expect(
    (await f.pay(order, refunded.payment.providerRef)).payment,
  ).toMatchObject({ _id: refunded.payment._id, status: "refunded" });
  expect(
    await models.Order.countDocuments({ eventId: f.eventId, status: "paid" }),
  ).toBe(1);
  expect(await models.Payment.countDocuments({ eventId: f.eventId })).toBe(2);
  expect(await models.Ticket.countDocuments({ eventId: f.eventId })).toBe(2);
  await f.quota(user, 0, 2);
  await f.clean();
});

test("T-PAY-DOUBLE-1 distinct orders racing for the same seat produce only one paid order and ticket", async () => {
  const f = await fixture();
  const a = await f.admit(),
    b = await f.admit();
  const old = await f.place(a, await f.hold(a, [0]));
  f.clock.advance(300_001);
  await f.booking.sweepExpired();
  const newer = await f.place(b, await f.hold(b, [0]));
  const [late, current] = await Promise.all([f.pay(old), f.pay(newer)]);
  expect(late).toMatchObject({
    order: { status: "failed", failureReason: "seats_unavailable" },
    payment: { status: "refunded" },
  });
  expect(current.order.status).toBe("paid");
  expect(
    await models.Order.countDocuments({ eventId: f.eventId, status: "paid" }),
  ).toBe(1);
  expect(
    await models.Ticket.countDocuments({
      eventId: f.eventId,
      seatId: f.seats[0]._id,
    }),
  ).toBe(1);
  await f.clean();
});

test("T-PAY-G order creation is idempotent across concurrent keys for the same hold", async () => {
  const f = await fixture();
  const user = await f.admit();
  const hold = await f.hold(user, [0, 1]);
  const orders = await Promise.all([
    f.place(user, hold, "first"),
    f.place(user, hold, "first"),
    f.place(user, hold, "second"),
  ]);
  expect(new Set(orders.map((order) => String(order._id))).size).toBe(1);
  expect(orders[0]).toMatchObject({
    amount: 39998,
    holdId: hold._id,
    passId: hold.passId,
  });
  expect(await models.Order.countDocuments({ eventId: f.eventId })).toBe(1);
  await f.clean();
});

test("T-PASS-1 and T-PASS-3 private inventory requires a pass and development tools are hidden by default", async () => {
  const f = await fixture();
  const app = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: { models, connection, env },
  });
  const token = (await request(app).post("/auth/demo").expect(200)).body.token;
  const auth = { Authorization: `Bearer ${token}` };
  await request(app)
    .get(`/events/${f.eventId}/seats`)
    .set(auth)
    .expect(403)
    .expect(({ body }) => expect(body.error.code).toBe("PASS_REQUIRED"));
  await request(app)
    .post(`/events/${f.eventId}/holds`)
    .set(auth)
    .send({ seatIds: [String(f.seats[0]._id)], idempotencyKey: "no-pass" })
    .expect(403);
  await request(app)
    .post("/dev/issue-pass")
    .set(auth)
    .send({ eventId: String(f.eventId) })
    .expect(404);
  const prod = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: {
      models,
      connection,
      env: { ...env, nodeEnv: "production", enableDevTools: true },
    },
  });
  await request(prod)
    .post("/dev/issue-pass")
    .set(auth)
    .send({ eventId: String(f.eventId) })
    .expect(404);
  await f.clean();
});

test("T-PASS-2 expired admission blocks inventory and hold changes while live holds can release or pay", async () => {
  const f = await fixture({ passSeconds: 60 });
  const a = await f.admit(),
    b = await f.admit();
  const first = await f.hold(a, [0]),
    second = await f.hold(b, [1]);
  f.clock.advance(60_001);
  await code(f.booking.listSeats(f.eventId, a), "PASS_REQUIRED");
  await code(f.hold(a, [2]), "PASS_REQUIRED");
  await code(f.change(a, first, [2]), "PASS_REQUIRED");
  expect((await f.booking.releaseHold(f.eventId, a, first._id)).status).toBe(
    "released",
  );
  expect((await f.pay(await f.place(b, second))).order.status).toBe("paid");
  await f.clean();
});

test("published cinema seats reach admitted attendees after the local sale transition", async () => {
  const clock = createFakeClock("2026-11-20T12:00:00Z");
  const events = createEventService({ ...models, connection, clock });
  const organizer = id();
  const draft = await events.create(
    {
      title: "Cinema inventory fixture",
      description: "A local demo screening.",
      venue: "Screen One",
      type: "cinema",
      saleStartsAt,
      startsAt,
      timeZone: "UTC",
      currency: "INR",
      isDemo: true,
      tierPrices: { front: 19999, standard: 29999, premium: 49999 },
    },
    organizer,
  );
  expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(0);
  const published = await events.publish(draft.id, organizer, draft.revision);
  expect(published).toMatchObject({ status: "scheduled", totalSeats: 120 });
  expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(120);

  clock.advance(Date.parse(saleStartsAt) - clock.now().getTime());
  const transition = await models.Event.collection.updateOne(
    {
      _id: new mongoose.Types.ObjectId(draft.id),
      status: "scheduled",
      isDemo: true,
      saleStartsAt: { $lte: clock.now() },
      startsAt: { $gt: clock.now() },
    },
    { $set: { status: "on_sale" } },
  );
  expect(transition.modifiedCount).toBe(1);

  const app = createApp({
    clock,
    clientOrigins: [],
    features: {
      models,
      connection,
      env: { ...env, nodeEnv: "development", enableDevTools: true },
    },
  });
  const { body: session } = await request(app).post("/auth/demo").expect(200);
  const auth = { Authorization: `Bearer ${session.token}` };
  const inventoryPath = `/events/${draft.id}/seats`;
  await request(app).get(inventoryPath).set(auth).expect(403);
  await request(app)
    .post("/dev/issue-pass")
    .set(auth)
    .send({ eventId: draft.id })
    .expect(200);
  const { body } = await request(app).get(inventoryPath).set(auth).expect(200);
  expect(body.seats).toHaveLength(120);
  expect(body.seats[0]).toMatchObject({ label: "A1", status: "available" });
  expect(body.seats[36]).toMatchObject({ label: "D1", status: "available" });
});

test("mock checkout verifies raw signatures, preserves privacy and produces an owned ticket through HTTP", async () => {
  const f = await fixture();
  const app = createApp({
    clock: f.clock,
    clientOrigins: [],
    features: {
      models,
      connection,
      env: { ...env, nodeEnv: "development", enableDevTools: true },
    },
  });
  const demo = async () => {
    const { body } = await request(app).post("/auth/demo").expect(200);
    return { Authorization: `Bearer ${body.token}` };
  };
  const auth = await demo(),
    other = await demo();
  await request(app)
    .post("/dev/issue-pass")
    .set(auth)
    .send({ eventId: String(f.eventId) })
    .expect(200);
  const base = `/events/${f.eventId}`;
  const suggestion = await request(app)
    .get(`${base}/best-available?tier=standard&count=3`)
    .set(auth)
    .expect(200);
  expect(suggestion.body.seats).toEqual([]);
  expect(suggestion.body.alternatives[0].map(({ label }) => label)).toEqual([
    "E1",
    "E2",
  ]);
  const {
    body: { hold },
  } = await request(app)
    .post(`${base}/holds`)
    .set(auth)
    .send({ seatIds: [String(f.seats[0]._id)], idempotencyKey: "http-hold" })
    .expect(200);
  const {
    body: { order },
  } = await request(app)
    .post("/orders")
    .set(auth)
    .send({
      eventId: String(f.eventId),
      holdId: hold.id,
      idempotencyKey: "http-order",
    })
    .expect(200);
  expect(order.amount).toBe(19999);
  await request(app).get(`/orders/${order.id}`).set(other).expect(404);
  await request(app)
    .post(`/orders/${order.id}/mock`)
    .set(other)
    .send({ outcome: "succeeded" })
    .expect(404);
  const send = (text, signature) =>
    request(app)
      .post("/payments/mock/webhook")
      .set("Content-Type", "application/json")
      .set("X-Mock-Signature", signature)
      .send(text);
  const badJson = "{";
  await send(badJson, "0".repeat(64)).expect(401);
  await send(badJson, signPayload(badJson, env.paymentWebhookSecret)).expect(
    400,
  );
  await request(app)
    .post(`/orders/${order.id}/mock`)
    .set(auth)
    .send({ outcome: "succeeded" })
    .expect(200)
    .expect(({ body }) =>
      expect(body).toMatchObject({
        order: { status: "paid" },
        payment: { status: "processed" },
      }),
    );
  await request(app)
    .get("/tickets/my")
    .set(other)
    .expect(200)
    .expect(({ body }) => expect(body.tickets).toEqual([]));
  await request(app)
    .get("/tickets/my")
    .set(auth)
    .expect(200)
    .expect(({ body }) =>
      expect(body.tickets).toEqual([
        expect.objectContaining({
          qrPayload: expect.any(String),
          seat: expect.objectContaining({ label: "A1" }),
          order: expect.objectContaining({ id: order.id }),
        }),
      ]),
    );
  await f.clean();
});

test("T-IDEMP-1 and T-IDEMP-2 fingerprints replay equivalent inputs and reject changes across all three operations", async () => {
  const f = await fixture();
  const user = await f.admit();
  const first = await f.hold(user, [0, 1], "book-seats");
  expect((await f.hold(user, [1, 0], "book-seats"))._id).toEqual(first._id);
  await code(f.hold(user, [1, 2], "book-seats"), "IDEMPOTENCY_CONFLICT");
  const order = await f.place(user, first, "checkout");
  expect((await f.place(user, first, "checkout"))._id).toEqual(order._id);
  const failed = await f.pay(order, "idemp-ref", "failed");
  expect(failed).toMatchObject({
    order: { status: "failed" },
    payment: { status: "failed" },
  });
  expect((await f.pay(order, "idemp-ref", "failed")).payment._id).toEqual(
    failed.payment._id,
  );
  await code(f.pay(order, "idemp-ref"), "IDEMPOTENCY_CONFLICT");
  await code(
    f.booking.confirmPayment({
      orderId: String(order._id),
      providerRef: "idemp-ref",
      outcome: "failed",
      amount: order.amount + 1,
    }),
    "IDEMPOTENCY_CONFLICT",
  );
  const other = await f.hold(user, [2], "other-hold");
  await code(f.place(user, other, "checkout"), "IDEMPOTENCY_CONFLICT");
  const secondEvent = await fixture();
  await secondEvent.admit(user);
  await code(secondEvent.hold(user, [0], "book-seats"), "IDEMPOTENCY_CONFLICT");
  await f.clean();
  await secondEvent.clean();
});

test("T-HOLD-INPUT-1 empty, repeated and cross-event IDs change neither inventory nor quotas", async () => {
  const f = await fixture();
  const second = await fixture();
  const user = await f.admit();
  for (const seats of [
    [],
    [f.seats[0]._id, f.seats[0]._id],
    [f.seats[0]._id, second.seats[0]._id],
    f.seats.slice(0, 5).map((seat) => seat._id),
  ]) {
    await code(
      f.booking.createHold(f.eventId, user, seats, String(id())),
      "INVALID_SEAT_SELECTION",
    );
  }
  expect(await models.Hold.countDocuments({ eventId: f.eventId })).toBe(0);
  await f.quota(user, 0, 0);
  await f.clean();
  await second.clean();
});

test("a missing requested seat blocks holds, new checkout and payment", async () => {
  const f = await fixture();
  const buyer = await f.admit(),
    shopper = await f.admit(),
    attendee = await f.admit();
  const order = await f.place(buyer, await f.hold(buyer, [0, 1]));
  const hold = await f.hold(shopper, [2, 3]);
  await models.Seat.deleteMany({
    eventId: f.eventId,
    _id: { $in: [f.seats[1]._id, f.seats[3]._id] },
  });

  await code(f.hold(attendee, [1, 4]), "INVALID_SEAT_SELECTION");
  await code(f.place(shopper, hold), "HOLD_EXPIRED");
  expect(await f.pay(order)).toMatchObject({
    order: { status: "failed", failureReason: "seats_unavailable" },
    payment: { status: "refunded" },
  });
  await f.quota(attendee, 0, 0);
  await f.quota(shopper, 2, 0);
  await f.quota(buyer, 2, 0);
  expect(await models.Order.countDocuments({ holdId: hold._id })).toBe(0);
  expect(await models.Seat.findById(f.seats[0]._id).lean()).toMatchObject({
    status: "held",
    holdId: order.holdId,
  });
  expect(await models.Ticket.countDocuments({ eventId: f.eventId })).toBe(0);
  expect(await f.booking.verifyEventIntegrity(f.eventId)).toContain(
    "Seat counts do not match the event inventory.",
  );
});

test("T-TICKET-1 signed ticket payload detects a substituted ticket ID", async () => {
  const f = await fixture();
  const user = await f.admit();
  const order = await f.place(user, await f.hold(user, [0]));
  await f.pay(order);
  const ticket = await models.Ticket.findOne({ orderId: order._id }).lean();
  expect(verifyTicketPayload(ticket.qrPayload, env.qrHmacSecret)).toBe(
    String(ticket._id),
  );
  expect(
    verifyTicketPayload(
      ticket.qrPayload.replace(String(ticket._id), String(id())),
      env.qrHmacSecret,
    ),
  ).toBeNull();
  await f.clean();
});

test("T-VERIFY-PENDING-1 allows stale pending orders and T-VERIFY-PAID-1 detects duplicate paid ownership", async () => {
  const f = await fixture();
  const a = await f.admit(),
    b = await f.admit();
  const old = await f.place(a, await f.hold(a, [0]));
  f.clock.advance(300_001);
  await f.booking.sweepExpired();
  await f.pay(await f.place(b, await f.hold(b, [0])));
  expect((await models.Order.findById(old._id)).status).toBe("pending");
  await f.clean();
  await models.Order.updateOne({ _id: old._id }, { status: "paid" });
  expect(await f.booking.verifyEventIntegrity(f.eventId)).toEqual(
    expect.arrayContaining([expect.stringMatching(/multiple paid orders/i)]),
  );
});

test("payment transient retry and uncertain commit leave one transition, payment, audit record and ticket", async () => {
  const f = await fixture();
  const user = await f.admit();
  const order = await f.place(user, await f.hold(user, [0]));
  const originalInsert = models.Ticket.insertMany.bind(models.Ticket);
  const insert = jest
    .spyOn(models.Ticket, "insertMany")
    .mockImplementationOnce(async (...args) => {
      await originalInsert(...args);
      throw new mongoose.mongo.MongoServerError({
        message: "fixture write conflict",
        code: 112,
        errorLabels: ["TransientTransactionError"],
      });
    });
  const start = connection.startSession.bind(connection);
  let commits = 0;
  const startSession = jest
    .spyOn(connection, "startSession")
    .mockImplementationOnce(async () => {
      const session = await start();
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        await commit();
        if (commits++ === 0)
          throw new mongoose.mongo.MongoServerError({
            message: "fixture commit reply lost",
            errorLabels: ["UnknownTransactionCommitResult"],
          });
      };
      return session;
    });
  try {
    expect((await f.pay(order, "fault-ref")).order.status).toBe("paid");
    expect((await f.pay(order, "fault-ref")).order.status).toBe("paid");
    expect(insert).toHaveBeenCalledTimes(2);
    expect(commits).toBe(2);
    expect(await models.Payment.countDocuments({ orderId: order._id })).toBe(1);
    expect(await models.Ticket.countDocuments({ orderId: order._id })).toBe(1);
    expect(
      await models.AuditLog.countDocuments({
        eventId: f.eventId,
        orderId: order._id,
        action: "order.paid",
      }),
    ).toBe(1);
  } finally {
    insert.mockRestore();
    startSession.mockRestore();
  }
  await f.clean();
});

test("late payment reconciles an unresolved commit without repeating the newer hold retirement", async () => {
  const f = await fixture();
  const { user, order, newerHold } = await oldOrderWithNewerHold(f);
  f.clock.advance(newerHold.expiresAt.getTime() - f.clock.now().getTime());
  const originalInsert = models.Ticket.insertMany.bind(models.Ticket);
  const insert = jest
    .spyOn(models.Ticket, "insertMany")
    .mockImplementationOnce(async (...args) => {
      await originalInsert(...args);
      throw new mongoose.mongo.MongoServerError({
        message: "fixture write conflict",
        code: 112,
        errorLabels: ["TransientTransactionError"],
      });
    });
  const start = connection.startSession.bind(connection);
  let commits = 0;
  const startSession = jest
    .spyOn(connection, "startSession")
    .mockImplementationOnce(async () => {
      const session = await start();
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        await commit();
        commits += 1;
        throw new mongoose.mongo.MongoServerError({
          message: "fixture commit reply lost",
          errorLabels: ["UnknownTransactionCommitResult"],
        });
      };
      return session;
    });
  try {
    await code(f.pay(order, "lost-ref"), "TXN_COMMIT_UNCONFIRMED");
    expect(commits).toBeGreaterThan(1);
    expect(insert).toHaveBeenCalledTimes(2);
  } finally {
    insert.mockRestore();
    startSession.mockRestore();
  }

  const persisted = await f.booking.getOrder(order._id, user);
  expect(persisted).toMatchObject({ status: "paid", passId: order.passId });
  expect(await f.pay(order, "lost-ref")).toMatchObject({
    order: persisted,
    payment: { status: "processed" },
  });
  await f.booking.sweepExpired();
  await f.quota(user, 0, 2);
  expect(await models.Payment.countDocuments({ orderId: order._id })).toBe(1);
  expect(await models.Ticket.countDocuments({ orderId: order._id })).toBe(2);
  expect(
    await models.AuditLog.countDocuments({
      holdId: newerHold._id,
      action: "hold.expired",
    }),
  ).toBe(1);
  expect(
    await models.AuditLog.countDocuments({
      orderId: order._id,
      action: "order.paid",
    }),
  ).toBe(1);
  await f.clean();
});

test("new event schedules need a 24-hour lead and new holds are closed at event start", async () => {
  const fields = {
    title: "Fixture",
    description: "Local",
    venue: "Local",
    type: "bus",
    startsAt,
    timeZone: "UTC",
    currency: "INR",
    tierPrices,
  };
  expect(
    createEventInput.safeParse({
      ...fields,
      saleStartsAt: "2026-11-23T12:00:01Z",
    }).success,
  ).toBe(false);
  expect(
    createEventInput.safeParse({
      ...fields,
      saleStartsAt: "2026-11-23T12:00:00Z",
    }).success,
  ).toBe(true);
  const f = await fixture();
  const user = await f.admit();
  f.clock.advance(Date.parse(startsAt) - f.clock.now().getTime());
  await code(f.hold(user, [0]), "SALE_CLOSED");
  await f.clean();
});

test("T-OVERSELL 500 seats and 2,000 simulated users produce 500 sales under genuine MongoDB contention", async () => {
  const f = await fixture({ count: 500 });
  const users = await seedAdmissions(f, 2000);
  const remaining = new Set(f.seats.map((_, index) => index));
  let random = 9142;
  let attempts = 0,
    conflicts = 0,
    cursor = 0;
  const conflicted = new Set(),
    retried = new Set();
  async function buyer() {
    while (cursor < users.length) {
      const user = users[cursor++];
      while (remaining.size) {
        if (conflicted.has(user)) retried.add(user);
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const seat = [...remaining][random % remaining.size];
        attempts += 1;
        try {
          const hold = await f.hold(user, [seat]);
          expect((await f.pay(await f.place(user, hold))).order.status).toBe(
            "paid",
          );
          remaining.delete(seat);
          break;
        } catch (error) {
          if (error.code !== "SEAT_UNAVAILABLE") throw error;
          conflicts += 1;
          conflicted.add(user);
          if (!remaining.size) {
            await code(f.hold(user, [seat]), "SEAT_UNAVAILABLE");
            attempts += 1;
            retried.add(user);
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 32 }, buyer));
  expect(remaining.size).toBe(0);
  expect(attempts).toBeGreaterThan(500);
  expect(conflicts).toBeGreaterThan(0);
  expect(retried).toEqual(conflicted);
  const sold = await models.Seat.find({
    eventId: f.eventId,
    status: "sold",
  }).lean();
  expect(sold).toHaveLength(500);
  const tickets = await models.Ticket.find({ eventId: f.eventId }).lean();
  expect(tickets).toHaveLength(500);
  expect(new Set(tickets.map((ticket) => String(ticket.seatId)))).toEqual(
    new Set(sold.map((seat) => String(seat._id))),
  );
  await f.clean();
  console.info(
    `T-OVERSELL: ${attempts} hold attempts, ${conflicts} conflicts, ${sold.length} sold seats`,
  );
}, 240_000);
