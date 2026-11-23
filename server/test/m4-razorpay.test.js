import { jest } from "@jest/globals";
import { fixture, newId, testDatabase } from "./m4-fixture.js";
import { signPayload } from "../src/modules/booking/signatures.js";
import { readEnv } from "../src/config/env.js";
import { createRazorpay } from "../src/modules/payments/razorpay.js";

const config = {
  keyId: "rzp_test_Fixture123",
  keySecret: "fixture-provider-api-secret",
  webhookSecret: "fixture-provider-webhook-secret",
};
const environment = {
  CLIENT_ORIGIN: "http://localhost:5173",
  MONGODB_URI: "mongodb://127.0.0.1/example",
  JWT_SECRET: "fixture-only-with-at-least-32-characters",
  PAYMENT_WEBHOOK_SECRET: "fixture-only-with-at-least-32-characters",
  QR_HMAC_SECRET: "fixture-only-with-at-least-32-characters",
};
let db;
beforeAll(async () => {
  db = await testDatabase("tickets_m4_razorpay");
});
beforeEach(async () => {
  await Promise.all(
    ["GatewayOrder", "GatewayAttempt", "GatewayEvent", "GatewayRefund"].map(
      (name) => db.models[name].deleteMany({}),
    ),
  );
});
afterAll(async () => {
  await db?.close();
});

function gateway() {
  const orders = new Map(),
    payments = new Map(),
    refunds = new Map(),
    calls = [];
  const prefix = String(newId()).slice(-12);
  const faults = {
    loseOrder: false,
    loseRefund: false,
    rejectOrder: false,
    refundStatus: "pending",
    hideOrders: false,
    hideRefunds: false,
  };
  const fetchImpl = jest.fn(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    expect(new URL(url).origin).toBe("https://api.razorpay.com");
    expect(options.headers.Authorization).toBe(
      "Basic " +
        Buffer.from(config.keyId + ":" + config.keySecret).toString("base64"),
    );
    const body = options.body && JSON.parse(options.body);
    const method = options.method;
    calls.push({
      method,
      pathname,
      body,
      key: options.headers["X-Refund-Idempotency"],
    });
    const send = (value, status = 200) => Response.json(value, { status });
    if (pathname === "/v1/orders" && method === "GET") {
      return send({
        items: faults.hideOrders
          ? []
          : [...orders.values()].filter(
              ({ receipt }) => receipt === searchParams.get("receipt"),
            ),
      });
    }
    if (pathname === "/v1/orders" && method === "POST") {
      if (faults.rejectOrder)
        return send({ error: { description: "fake upstream refusal" } }, 400);
      if (orders.has(body.receipt)) return send({}, 400);
      const order = { ...body, id: "order_" + prefix + (orders.size + 1) };
      orders.set(body.receipt, order);
      if (faults.loseOrder) {
        faults.loseOrder = false;
        throw new TypeError("Lost gateway response");
      }
      return send(order);
    }
    const list = /^\/v1\/orders\/(order_\w+)\/payments$/.exec(pathname);
    if (list)
      return send({
        items: [...payments.values()].filter(
          (payment) => payment.order_id === list[1],
        ),
      });
    const payment = /^\/v1\/payments\/(pay_\w+)$/.exec(pathname);
    if (payment)
      return payments.has(payment[1])
        ? send(payments.get(payment[1]))
        : send({}, 404);
    const refund =
      /^\/v1\/payments\/(pay_\w+)\/(refund|refunds)(?:\/(rfnd_\w+))?$/.exec(
        pathname,
      );
    if (refund) {
      const matches = [...refunds.values()].filter(
        (entry) => entry.payment_id === refund[1],
      );
      if (method === "GET" && !refund[3])
        return send({ items: faults.hideRefunds ? [] : matches });
      if (method === "GET")
        return send({
          ...matches.find(({ id }) => id === refund[3]),
          status: faults.refundStatus,
        });
      const key = options.headers["X-Refund-Idempotency"];
      const value = refunds.get(key) ?? {
        ...body,
        id: "rfnd_" + prefix + (refunds.size + 1),
        payment_id: refund[1],
        currency: "INR",
        status: faults.refundStatus,
      };
      refunds.set(key, value);
      if (faults.loseRefund) {
        faults.loseRefund = false;
        throw new TypeError("Lost refund response");
      }
      return send(value);
    }
    throw new Error("Unexpected fixture URL: " + method + " " + pathname);
  });
  return { fetchImpl, orders, payments, refunds, calls, faults, prefix };
}

async function setup({ queued = false, ...options } = {}) {
  const provider = gateway();
  let service, makeService;
  const f = await fixture(db, {
    ...options,
    env: { paymentProvider: "razorpay", razorpay: config },
    razorpay(context) {
      makeService = () =>
        createRazorpay({ ...context, config, fetchImpl: provider.fetchImpl });
      service = makeService();
      return service;
    },
  });
  const buyer = await f.user();
  const queuePath = "/events/" + f.event._id + "/queue";
  if (queued) {
    const joined = await f.api
      .post(queuePath + "/join")
      .set("Authorization", f.auth(buyer));
    expect(joined.body.entry).toMatchObject({ status: "waiting", number: 1 });
    await f.queue.admit(f.event._id);
  }
  const { hold, order } = await (queued ? f.place : f.begin)(buyer._id);
  const url = "/orders/" + order._id;
  const post = (path, body) =>
    f.api
      .post(url + path)
      .set("Authorization", f.auth(buyer))
      .send(body);
  function attempt(checkout, id, status, changes = {}) {
    const payment = {
      id: "pay_" + provider.prefix + id,
      order_id: checkout.orderId,
      status,
      amount: order.amount,
      currency: order.currency,
      captured: status === "captured",
      ...changes,
    };
    provider.payments.set(payment.id, payment);
    return payment;
  }
  function webhook(
    payment,
    eventId,
    event = "payment.captured",
    signature = null,
  ) {
    const raw =
      " {\n  " +
      JSON.stringify({
        event,
        payload: {
          payment: { entity: payment },
          ...(event === "order.paid" && {
            order: { entity: { id: payment.order_id } },
          }),
        },
      }).slice(1) +
      "\n";
    return f.api
      .post("/payments/razorpay/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Event-Id", eventId)
      .set(
        "X-Razorpay-Signature",
        signature ?? signPayload(raw, config.webhookSecret),
      )
      .send(raw);
  }
  function verify(checkout, paymentId, signature) {
    return post("/razorpay/verify", {
      razorpay_order_id: checkout.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature:
        signature ??
        signPayload(checkout.orderId + "|" + paymentId, config.keySecret),
    });
  }
  const start = () => post("/razorpay", {});
  const state = () => f.api.get(url).set("Authorization", f.auth(buyer));
  return {
    ...f,
    provider,
    service,
    makeService,
    buyer,
    hold,
    order,
    start,
    state,
    attempt,
    webhook,
    verify,
    post,
    queuePath,
  };
}

test("Razorpay defaults off and explicit configuration refuses live or incomplete credentials", () => {
  expect(readEnv(environment).paymentProvider).toBe("mock");
  const input = {
    ...environment,
    PAYMENT_PROVIDER: "razorpay",
    RAZORPAY_KEY_SECRET: config.keySecret,
    RAZORPAY_WEBHOOK_SECRET: config.webhookSecret,
  };
  expect(() =>
    readEnv({ ...input, RAZORPAY_KEY_ID: "rzp_live_Example" }),
  ).toThrow("RAZORPAY_KEY_ID");
  expect(() =>
    readEnv({
      ...input,
      RAZORPAY_KEY_ID: config.keyId,
      RAZORPAY_WEBHOOK_SECRET: "",
    }),
  ).toThrow("RAZORPAY_WEBHOOK_SECRET");
  expect(
    readEnv({ ...input, RAZORPAY_KEY_ID: config.keyId }).paymentProvider,
  ).toBe("razorpay");
});

test("gateway order uses persisted INR paise and concurrent retries recover one lost create response", async () => {
  const f = await setup();
  f.provider.faults.loseOrder = true;
  const results = await Promise.all([f.start(), f.start()]);
  expect(results.map(({ status }) => status)).toEqual([200, 200]);
  const checkout = results[0].body.checkout;
  expect(checkout).toMatchObject({
    amount: 19999,
    currency: "INR",
    keyId: config.keyId,
  });
  expect(results[1].body.checkout.orderId).toBe(checkout.orderId);
  expect(JSON.stringify(results)).not.toContain(config.keySecret);
  expect(
    f.provider.calls.filter(({ method }) => method === "POST"),
  ).toHaveLength(1);
  expect(f.provider.orders.size).toBe(1);
  expect(await f.models.Order.countDocuments({ userId: f.buyer._id })).toBe(1);
  expect(await f.models.GatewayOrder.findById(f.order._id)).toMatchObject({
    receipt: "qt_" + f.order._id,
    gatewayOrderId: checkout.orderId,
  });
  expect((await f.post("/mock", { outcome: "succeeded" })).status).toBe(409);
});

test("an unavailable order create preserves the local pending booking for a stable retry", async () => {
  const f = await setup();
  f.provider.faults.rejectOrder = true;
  expect((await f.start()).status).toBe(503);
  expect((await f.state()).body.order.status).toBe("pending");
  expect(await f.models.GatewayOrder.findById(f.order._id)).toMatchObject({
    receipt: "qt_" + f.order._id,
  });
  f.provider.faults.rejectOrder = false;
  expect((await f.start()).status).toBe(200);
  expect(
    new Set(
      f.provider.calls
        .filter(({ method }) => method === "POST")
        .map(({ body }) => body.receipt),
    ).size,
  ).toBe(1);
});

test("recreating the gateway service reconciles an unconfirmed creation without a second POST", async () => {
  const f = await setup();
  f.provider.faults.loseOrder = true;
  f.provider.faults.hideOrders = true;
  expect((await f.start()).status).toBe(503);
  const before = await f.models.GatewayOrder.findById(f.order._id).lean();
  expect(before.gatewayOrderId).toBeUndefined();
  f.provider.faults.hideOrders = false;
  f.clock.advance(31_000);
  await f.makeService().maintain();
  const settled = await f.models.GatewayOrder.findById(f.order._id).lean();
  expect(settled.gatewayOrderId).toBe(f.provider.orders.get(before.receipt).id);
  expect((await f.start()).body.checkout.orderId).toBe(settled.gatewayOrderId);
  expect(
    f.provider.calls.filter(({ method }) => method === "POST"),
  ).toHaveLength(1);
});

test("authenticated failed/authorized attempts are nonterminal, and only a verified capture fulfils once", async () => {
  const f = await setup();
  const { checkout } = (await f.start()).body;
  const failed = f.attempt(checkout, "Failed", "failed");
  const authorized = f.attempt(checkout, "Success", "authorized");
  expect((await f.webhook(failed, "evt_failed", "payment.failed")).status).toBe(
    200,
  );
  expect((await f.verify(checkout, authorized.id)).status).toBe(200);
  expect((await f.state()).body.order.status).toBe("pending");
  expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
    0,
  );
  const captured = f.attempt(checkout, "Success", "captured");
  const replay = await Promise.all([
    f.verify(checkout, captured.id),
    f.webhook(captured, "evt_captured"),
    f.webhook(captured, "evt_captured"),
    f.webhook(captured, "evt_distinct"),
    f.webhook(failed, "evt_late_failure", "payment.failed"),
  ]);
  expect(replay.map(({ status }) => status)).toEqual(Array(5).fill(200));
  expect((await f.state()).body.order.status).toBe("paid");
  expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
    1,
  );
  expect(await f.models.Payment.countDocuments({ orderId: f.order._id })).toBe(
    1,
  );
  expect(
    await f.models.GatewayEvent.countDocuments({ orderId: f.order._id }),
  ).toBe(4);
  expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
});

test("rejects tampered signatures, unknown payments, mismatches and forged associations", async () => {
  const f = await setup();
  const { checkout } = (await f.start()).body;
  const good = f.attempt(checkout, "Good", "captured");
  const amount = f.attempt(checkout, "WrongAmount", "captured", { amount: 1 });
  const currency = f.attempt(checkout, "WrongCurrency", "captured", {
    currency: "USD",
  });
  const elsewhere = f.attempt(checkout, "OtherOrder", "captured", {
    order_id: "order_Elsewhere",
  });
  expect((await f.verify(checkout, good.id, "0".repeat(64))).status).toBe(401);
  expect(
    (
      await f.webhook(
        good,
        "bad_raw",
        "payment.captured",
        signPayload(JSON.stringify(good), config.webhookSecret),
      )
    ).status,
  ).toBe(401);
  expect((await f.verify(checkout, "pay_Unknown")).status).toBe(404);
  expect((await f.verify(checkout, amount.id)).status).toBe(422);
  expect((await f.verify(checkout, currency.id)).status).toBe(422);
  expect(
    (await f.webhook({ ...elsewhere, order_id: checkout.orderId }, "mislinked"))
      .status,
  ).toBe(422);
  expect((await f.state()).body.order.status).toBe("pending");
  expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
    0,
  );
});

test("a fresh gateway service reconciles capture without a callback after the hold and pass expire", async () => {
  const f = await setup({ event: { passSeconds: 60 } });
  const { checkout } = (await f.start()).body;
  const captured = f.attempt(checkout, "AfterRestart", "captured");
  f.clock.advance(301_000);
  await f.sweep();
  const laterPass = await f.booking.issuePass(f.event._id, f.buyer._id);
  await f.makeService().maintain();
  expect((await f.state()).body.order.status).toBe("paid");
  const paid = await f.models.Order.findById(f.order._id);
  expect(paid.holdId).toEqual(f.hold._id);
  expect(paid.passId).not.toEqual(laterPass._id);
  expect((await f.models.Pass.findById(laterPass._id)).status).toBe("expired");
  expect((await f.webhook(captured, "evt_after_restart")).status).toBe(200);
  expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
    1,
  );
  expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
});

test.each(["live", "overdue-unswept", "overdue-swept"])(
  "captured late payment handles a %s newer hold",
  async (stateOfNewerHold) => {
    const f = await setup({ event: { passSeconds: 60 } });
    const { checkout } = (await f.start()).body;
    f.clock.advance(301_000);
    await f.sweep();
    await f.booking.issuePass(f.event._id, f.buyer._id);
    const newer = await f.booking.createHold(
      f.event._id,
      f.buyer._id,
      [f.seats[1]._id],
      "different",
    );
    const live = stateOfNewerHold === "live";
    if (!live) f.clock.advance(300_001);
    if (stateOfNewerHold === "overdue-swept") await f.sweep();
    const paid = f.attempt(checkout, "Late", "captured");
    expect((await f.webhook(paid, "evt_late_" + stateOfNewerHold)).status).toBe(
      200,
    );
    const state = await f.state();
    if (!live) {
      expect(state.body.order.status).toBe("paid");
      expect((await f.models.Hold.findById(newer._id)).status).toBe("expired");
      expect(
        await f.models.Ticket.countDocuments({ orderId: f.order._id }),
      ).toBe(1);
      expect(
        await f.models.Quota.findOne({
          eventId: f.event._id,
          userId: f.buyer._id,
        }).lean(),
      ).toMatchObject({
        held: 0,
        bought: 1,
      });
      expect(
        await f.models.GatewayRefund.countDocuments({ orderId: f.order._id }),
      ).toBe(0);
    } else {
      expect(state.body.order).toMatchObject({
        status: "failed",
        failureReason: "superseded",
      });
      expect(state.body.payment.refund.status).toBe("requested");
      f.provider.faults.loseRefund = true;
      await f.makeService().maintain();
      expect((await f.state()).body.payment.refund.status).toBe("unknown");
      f.clock.advance(31_000);
      await Promise.all([
        f.makeService().maintain(),
        f.makeService().maintain(),
      ]);
      expect((await f.state()).body.payment.refund.status).toBe("pending");
      expect(f.provider.refunds.size).toBe(1);
      expect(
        f.provider.calls.filter(
          ({ pathname, method }) =>
            pathname.endsWith("/refund") && method === "POST",
        ),
      ).toHaveLength(1);
      f.provider.faults.refundStatus = "processed";
      f.clock.advance(31_000);
      await f.makeService().maintain();
      expect((await f.state()).body.payment.refund.status).toBe("processed");
      expect((await f.models.Hold.findById(newer._id)).status).toBe("active");
      expect(
        await f.models.Ticket.countDocuments({ orderId: f.order._id }),
      ).toBe(0);
    }
    expect(
      await f.booking.verifyEventIntegrity(f.event._id, { preSweep: true }),
    ).toEqual([]);
  },
);

test.each(["unswept", "swept"])(
  "Razorpay can settle an expired %s original hold while the seat remains available",
  async (state) => {
    const f = await setup();
    const { checkout } = (await f.start()).body;
    f.clock.advance(300_001);
    if (state === "swept") await f.sweep();
    const captured = f.attempt(checkout, "Original" + state, "captured");
    expect((await f.webhook(captured, "evt_original_" + state)).status).toBe(
      200,
    );
    expect((await f.state()).body.order.status).toBe("paid");
    expect(await f.models.Hold.findById(f.hold._id).lean()).toMatchObject({
      status: "converted",
    });
    expect(await f.models.Pass.findById(f.order.passId).lean()).toMatchObject({
      status: "used",
    });
    expect(
      await f.models.Quota.findOne({
        eventId: f.event._id,
        userId: f.buyer._id,
      }).lean(),
    ).toMatchObject({ held: 0, bought: 1 });
    expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
      1,
    );
    expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
  },
);

test.each(["waiting", "admitted"])(
  "a captured original order completes a real rejoin while %s",
  async (afterRejoin) => {
    const f = await setup({ queued: true, event: { passSeconds: 60 } });
    const { checkout } = (await f.start()).body;
    const entry = () =>
      f.models.QueueEntry.findOne({
        eventId: f.event._id,
        userId: f.buyer._id,
      }).lean();
    expect(await entry()).toMatchObject({
      number: 1,
      status: "admitted",
      passId: f.order.passId,
    });
    f.clock.advance(60_000);
    await f.sweep();
    expect(await entry()).toMatchObject({ number: 1, status: "expired" });
    const rejoined = await f.api
      .post(f.queuePath + "/rejoin")
      .set("Authorization", f.auth(f.buyer))
      .send({ idempotencyKey: "rejoin" });
    expect(rejoined.body.entry).toMatchObject({
      number: 2,
      status: "waiting",
      rejoinCount: 1,
    });
    if (afterRejoin === "admitted") await f.queue.admit(f.event._id);
    const current = await entry();
    expect(current.status).toBe(afterRejoin);
    if (afterRejoin === "admitted")
      expect(String(current.passId)).not.toBe(String(f.order.passId));

    const captured = f.attempt(checkout, "Rejoin" + afterRejoin, "captured");
    expect(
      (await f.webhook(captured, "evt_rejoin_" + afterRejoin)).status,
    ).toBe(200);
    expect(await f.models.Order.findById(f.order._id).lean()).toMatchObject({
      status: "paid",
      holdId: f.hold._id,
      passId: f.order.passId,
    });
    expect(await entry()).toMatchObject({
      number: 2,
      status: "completed",
      rejoinCount: 1,
    });
    expect(
      await f.models.QueueEntry.countDocuments({ eventId: f.event._id }),
    ).toBe(1);
    expect(
      (await f.models.Event.findById(f.event._id).lean()).admittedUpTo,
    ).toBe(afterRejoin === "waiting" ? 1 : 2);
    expect((await f.models.Pass.findById(f.order.passId).lean()).status).toBe(
      "used",
    );
    if (afterRejoin === "admitted")
      expect((await f.models.Pass.findById(current.passId).lean()).status).toBe(
        "expired",
      );
    expect(
      await f.models.Pass.countDocuments({
        eventId: f.event._id,
        status: "active",
      }),
    ).toBe(0);
    expect(await f.models.Ticket.countDocuments({ orderId: f.order._id })).toBe(
      1,
    );
    expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
  },
);

test("a newer paid Razorpay order keeps its seat when the older order is captured later", async () => {
  const f = await setup({ event: { passSeconds: 60 } });
  const { checkout } = (await f.start()).body;
  f.clock.advance(300_001);
  await f.sweep();
  const { order: newer } = await f.begin(f.buyer._id, f.seats[1]);
  const newerStart = await f.api
    .post("/orders/" + newer._id + "/razorpay")
    .set("Authorization", f.auth(f.buyer))
    .send({});
  expect(newerStart.status).toBe(200);
  const newerCapture = f.attempt(newerStart.body.checkout, "Newer", "captured");
  expect(
    (await f.webhook(newerCapture, "evt_newer_paid", "order.paid")).status,
  ).toBe(200);
  expect((await f.webhook(newerCapture, "evt_newer_captured")).status).toBe(
    200,
  );
  const originalCapture = f.attempt(checkout, "Older", "captured");
  expect((await f.webhook(originalCapture, "evt_older_captured")).status).toBe(
    200,
  );

  expect((await f.state()).body).toMatchObject({
    order: { status: "failed", failureReason: "already_booked" },
    payment: { refund: { status: "requested" } },
  });
  expect(await f.models.Order.findById(newer._id).lean()).toMatchObject({
    status: "paid",
  });
  expect(await f.models.Ticket.find({ eventId: f.event._id }).lean()).toEqual([
    expect.objectContaining({ orderId: newer._id, seatId: f.seats[1]._id }),
  ]);
  expect(
    await f.models.Quota.findOne({
      eventId: f.event._id,
      userId: f.buyer._id,
    }).lean(),
  ).toMatchObject({ held: 0, bought: 1 });
  expect(await f.models.Seat.findById(f.seats[0]._id).lean()).toMatchObject({
    status: "available",
  });
  expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
});

test("a late capture cannot claim a seat still held by another attendee", async () => {
  const f = await setup();
  const { checkout } = (await f.start()).body;
  f.clock.advance(300_001);
  await f.sweep();
  const other = await f.user();
  const { hold: newer } = await f.begin(other._id);
  const captured = f.attempt(checkout, "SeatHeld", "captured");
  expect((await f.webhook(captured, "evt_seat_held")).status).toBe(200);
  expect((await f.state()).body).toMatchObject({
    order: { status: "failed", failureReason: "seats_unavailable" },
    payment: { refund: { status: "requested" } },
  });
  expect(await f.models.Seat.findById(f.seats[0]._id).lean()).toMatchObject({
    status: "held",
    holdId: newer._id,
  });
  expect(await f.models.Ticket.countDocuments({ eventId: f.event._id })).toBe(
    0,
  );
  expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
});

test("capture for seats sold to someone else schedules an external refund and never oversells", async () => {
  const f = await setup();
  const { checkout } = (await f.start()).body;
  f.clock.advance(301_000);
  await f.sweep();
  const other = await f.user();
  const booking = await f.begin(other._id);
  await f.booking.confirmPayment({
    orderId: booking.order._id,
    provider: "razorpay",
    gatewayPaymentId: "pay_SeatOwner",
    providerRef: "razorpay:pay_SeatOwner",
    outcome: "succeeded",
  });
  const captured = f.attempt(checkout, "Reclaimed", "captured");
  expect((await f.webhook(captured, "evt_reclaimed")).status).toBe(200);
  const state = (await f.state()).body;
  expect(state.order).toMatchObject({
    status: "failed",
    failureReason: "seats_unavailable",
  });
  expect(state.payment.refund.status).toBe("requested");
  expect(await f.models.Ticket.countDocuments({ eventId: f.event._id })).toBe(
    1,
  );
  f.provider.faults.loseRefund = true;
  f.provider.faults.hideRefunds = true;
  await f.makeService().maintain();
  expect((await f.state()).body.payment.refund.status).toBe("unknown");
  f.clock.advance(31_000);
  await f.makeService().maintain();
  const attempts = f.provider.calls.filter(
    ({ pathname, method }) => pathname.endsWith("/refund") && method === "POST",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(f.provider.refunds.size).toBe(1);
  expect((await f.state()).body.payment.refund.status).toBe("pending");
  expect(await f.booking.verifyEventIntegrity(f.event._id)).toEqual([]);
});
