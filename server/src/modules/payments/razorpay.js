import { createHash } from "node:crypto";
import { z } from "zod";
import { validate } from "../../lib/http.js";
import { fail, sameId } from "../booking/rules.js";
import { validSignature } from "../booking/signatures.js";
import {
  createRazorpayClient,
  RazorpayRequestError,
} from "./razorpay-client.js";

const idPattern = (type) => new RegExp("^" + type + "_[A-Za-z0-9]{1,64}$");
const orderId = z.string().regex(idPattern("order"));
const paymentId = z.string().regex(idPattern("pay"));
const refundId = z.string().regex(idPattern("rfnd"));
export const checkoutResult = z.strictObject({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
});
const paymentEntity = z.object({
  id: paymentId,
  order_id: orderId,
  amount: z.number().int().positive(),
  currency: z.string(),
  status: z.enum(["created", "authorized", "captured", "failed", "refunded"]),
  captured: z.boolean(),
});
const refundEntity = z.object({
  id: refundId,
  payment_id: paymentId,
  amount: z.number().int().positive(),
  currency: z.string(),
  status: z.enum(["pending", "processed", "failed"]),
  receipt: z.string(),
});
const paymentEvents = new Set([
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
]);
const webhookEntity = z.object({
  event: z.string().max(64),
  payload: z.object({
    payment: z.object({
      entity: z.object({ id: paymentId, order_id: orderId }),
    }),
    order: z.object({ entity: z.object({ id: orderId }) }).optional(),
  }),
});
const unavailable = () =>
  fail(
    503,
    "GATEWAY_UNAVAILABLE",
    "Razorpay Test Mode could not confirm the result. Check booking status before retrying.",
  );
const mismatch = () =>
  fail(
    422,
    "GATEWAY_PAYMENT_MISMATCH",
    "The gateway payment did not match this booking.",
  );
const providerOf = (order) => order.paymentProvider ?? "mock";
const next = (clock, delay) => new Date(+clock.now() + delay);
const atLeast = { writeConcern: { w: "majority" } };

export function createRazorpay({ models, booking, clock, config, fetchImpl }) {
  const {
    GatewayOrder,
    GatewayAttempt,
    GatewayEvent,
    GatewayRefund,
    Order,
    Hold,
    Seat,
  } = models;
  const client = createRazorpayClient(config, fetchImpl);
  const starting = new Map();
  let working = false;

  function orderConfig(record) {
    return {
      keyId: config.keyId,
      orderId: record.gatewayOrderId,
      amount: record.amount,
      currency: record.currency,
    };
  }

  async function assertPayable(order) {
    if (providerOf(order) !== "razorpay")
      throw fail(
        409,
        "PAYMENT_PROVIDER_MISMATCH",
        "This order uses a different payment provider.",
      );
    const owned = { eventId: order.eventId, userId: order.userId };
    const [hold, count] = await Promise.all([
      Hold.exists({
        ...owned,
        _id: order.holdId,
        passId: order.passId,
        status: "active",
        expiresAt: { $gt: clock.now() },
      }),
      Seat.countDocuments({
        eventId: order.eventId,
        _id: { $in: order.seatIds },
        status: "held",
        holdId: order.holdId,
      }),
    ]);
    if (order.status !== "pending" || !hold || count !== order.seatIds.length)
      throw fail(409, "HOLD_EXPIRED", "The hold ended before payment began.");
    if (
      order.currency !== "INR" ||
      !Number.isSafeInteger(order.amount) ||
      order.amount < 100
    )
      throw fail(
        409,
        "UNSUPPORTED_GATEWAY_AMOUNT",
        "Razorpay Test Mode requires a total of at least ₹1.00 in INR.",
      );
    if (
      order.seatLines.length !== count ||
      order.seatLines.reduce((sum, { price }) => sum + price, 0) !==
        order.amount
    )
      throw mismatch();
  }

  async function storeMapping(record, order) {
    if (
      !orderId.safeParse(order?.id).success ||
      order.receipt !== record.receipt ||
      order.amount !== record.amount ||
      order.currency !== record.currency
    )
      throw unavailable();
    const result = await GatewayOrder.findOneAndUpdate(
      {
        _id: record._id,
        $or: [
          { gatewayOrderId: { $exists: false } },
          { gatewayOrderId: order.id },
        ],
      },
      { $set: { gatewayOrderId: order.id, nextCheckAt: next(clock, 10_000) } },
      { ...atLeast, new: true },
    ).lean();
    if (!result) throw unavailable();
    return result;
  }

  async function reconcileMapping(record) {
    const result = await client.findOrders(record.receipt);
    if (!Array.isArray(result.items)) throw unavailable();
    const matches = result.items.filter(
      ({ receipt }) => receipt === record.receipt,
    );
    if (matches.length > 1) throw unavailable();
    return matches.length ? storeMapping(record, matches[0]) : null;
  }

  async function begin(order) {
    await assertPayable(order);
    const key = String(order._id);
    if (starting.has(key)) return starting.get(key);
    if (starting.size >= 32) throw unavailable();

    const work = (async () => {
      const receipt = "qt_" + key;
      const { amount, currency } = order;
      let record;
      try {
        record = await GatewayOrder.findOneAndUpdate(
          { _id: order._id },
          { $setOnInsert: { receipt, amount, currency } },
          { ...atLeast, upsert: true, new: true },
        ).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        record = await GatewayOrder.findById(order._id).lean();
      }
      if (
        !record ||
        record.receipt !== receipt ||
        record.amount !== amount ||
        record.currency !== currency
      )
        throw unavailable();
      if (record.gatewayOrderId) return orderConfig(record);

      if (record.submittedAt) {
        const recovered = await reconcileMapping(record);
        if (recovered) return orderConfig(recovered);
      }
      const submitted = await GatewayOrder.updateOne(
        { _id: record._id, gatewayOrderId: { $exists: false } },
        {
          $set: { submittedAt: clock.now(), nextCheckAt: next(clock, 30_000) },
        },
        atLeast,
      );
      if (!submitted.matchedCount) {
        const current = await GatewayOrder.findById(record._id).lean();
        if (!current?.gatewayOrderId) throw unavailable();
        return orderConfig(current);
      }
      let gatewayOrder;
      try {
        gatewayOrder = await client.createOrder({
          amount,
          currency,
          receipt,
          partial_payment: false,
        });
      } catch (error) {
        // A lost response and a duplicate receipt require the same lookup.
        if (!(error instanceof RazorpayRequestError)) throw error;
        const recovered = await reconcileMapping(record);
        if (recovered) return orderConfig(recovered);
        throw unavailable();
      }
      return orderConfig(await storeMapping(record, gatewayOrder));
    })()
      .catch((error) => {
        if (error instanceof RazorpayRequestError) throw unavailable();
        throw error;
      })
      .finally(() => starting.delete(key));
    starting.set(key, work);
    return work;
  }

  async function payment(record, value, expectedId, trustedOrder = null) {
    const parsed = paymentEntity.safeParse(value);
    if (!parsed.success) throw mismatch();
    const entity = parsed.data;
    if (
      entity.id !== expectedId ||
      entity.order_id !== record.gatewayOrderId ||
      entity.amount !== record.amount ||
      entity.currency !== record.currency
    )
      throw mismatch();
    const order = trustedOrder ?? (await Order.findById(record._id).lean());
    if (
      !order ||
      providerOf(order) !== "razorpay" ||
      order.amount !== entity.amount ||
      order.currency !== entity.currency
    )
      throw mismatch();
    const existing = await GatewayAttempt.findById(entity.id).lean();
    if (existing && !sameId(existing.orderId, order._id)) throw mismatch();

    try {
      await GatewayAttempt.updateOne(
        { _id: entity.id, orderId: order._id },
        {
          $setOnInsert: {
            amount: entity.amount,
            currency: entity.currency,
            status: entity.status,
            checkedAt: clock.now(),
          },
        },
        { ...atLeast, upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      const raced = await GatewayAttempt.findById(entity.id).lean();
      if (!raced || !sameId(raced.orderId, order._id)) throw mismatch();
    }
    const scope = { _id: entity.id, orderId: order._id };
    if (entity.status !== "captured" || !entity.captured) {
      if (entity.status === "captured") throw mismatch();
      await GatewayAttempt.updateOne(
        { ...scope, status: { $nin: ["captured", "refunded"] } },
        { $set: { status: entity.status, checkedAt: clock.now() } },
        atLeast,
      );
      return;
    }

    await booking.confirmPayment({
      orderId: order._id,
      provider: "razorpay",
      providerRef: "razorpay:" + entity.id,
      gatewayPaymentId: entity.id,
      amount: entity.amount,
      outcome: "succeeded",
    });
    await Promise.all([
      GatewayAttempt.updateOne(
        scope,
        {
          $set: {
            status: "captured",
            checkedAt: clock.now(),
            settledAt: clock.now(),
          },
        },
        atLeast,
      ),
      GatewayOrder.updateOne(
        { _id: record._id },
        { $unset: { nextCheckAt: 1 } },
        atLeast,
      ),
    ]);
  }

  async function verifyPayment(record, id, order) {
    try {
      await payment(record, await client.getPayment(id), id, order);
    } catch (error) {
      if (error instanceof RazorpayRequestError) {
        if (error.status === 404)
          throw fail(
            404,
            "GATEWAY_PAYMENT_NOT_FOUND",
            "The gateway payment could not be found.",
          );
        throw unavailable();
      }
      throw error;
    }
  }

  async function verifyCheckout(order, input) {
    const record = await GatewayOrder.findById(order._id).lean();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      input;
    if (
      providerOf(order) !== "razorpay" ||
      !record?.gatewayOrderId ||
      razorpay_order_id !== record.gatewayOrderId ||
      !validSignature(
        record.gatewayOrderId + "|" + razorpay_payment_id,
        razorpay_signature,
        config.keySecret,
      )
    )
      throw fail(
        401,
        "INVALID_CHECKOUT_SIGNATURE",
        "The checkout signature is invalid.",
      );
    await verifyPayment(record, razorpay_payment_id, order);
  }

  async function webhook(raw, signature, eventId) {
    if (
      !Buffer.isBuffer(raw) ||
      !validSignature(raw, signature, config.webhookSecret)
    )
      throw fail(
        401,
        "INVALID_WEBHOOK_SIGNATURE",
        "The payment signature is invalid.",
      );
    if (!eventId || !/^[\w-]{1,128}$/.test(eventId))
      throw fail(
        400,
        "INVALID_GATEWAY_EVENT",
        "The gateway event identifier is invalid.",
      );
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw fail(400, "INVALID_JSON", "Send valid JSON.");
    }
    if (!body || typeof body.event !== "string")
      throw fail(400, "INVALID_GATEWAY_EVENT", "The gateway event is invalid.");
    if (!paymentEvents.has(body.event)) return;

    const input = validate(webhookEntity, body);
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const duplicate = await GatewayEvent.findById(eventId).lean();
    if (duplicate) return checkDuplicate(duplicate, bodyHash);
    const { id, order_id } = input.payload.payment.entity;
    if (
      input.event === "order.paid" &&
      input.payload.order?.entity.id !== order_id
    )
      throw mismatch();
    const record = await GatewayOrder.findOne({
      gatewayOrderId: order_id,
    }).lean();
    if (!record) throw mismatch();
    await verifyPayment(record, id);
    try {
      await GatewayEvent.create(
        [
          {
            _id: eventId,
            orderId: record._id,
            paymentId: id,
            eventType: input.event,
            bodyHash,
            processedAt: clock.now(),
          },
        ],
        atLeast,
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      checkDuplicate(await GatewayEvent.findById(eventId).lean(), bodyHash);
    }
  }

  async function refund(intent) {
    const scope = {
      _id: intent._id,
      status: { $in: ["requested", "unknown", "pending"] },
    };
    try {
      const result = intent.refundId
        ? await client.getRefund(intent._id, intent.refundId)
        : await recoverOrCreateRefund(intent);
      const value = refundEntity.safeParse(result);
      if (
        !value.success ||
        value.data.payment_id !== intent._id ||
        value.data.amount !== intent.amount ||
        value.data.currency !== intent.currency ||
        value.data.receipt !== intent.receipt ||
        (intent.refundId && value.data.id !== intent.refundId)
      )
        throw mismatch();
      const { status, id } = value.data;
      await GatewayRefund.updateOne(
        scope,
        {
          $set: { status, refundId: id, checkedAt: clock.now() },
          ...(status !== "pending" && { $unset: { nextCheckAt: 1 } }),
        },
        atLeast,
      );
    } catch (error) {
      if (
        error instanceof RazorpayRequestError ||
        error.code === "GATEWAY_PAYMENT_MISMATCH"
      ) {
        await GatewayRefund.updateOne(
          scope,
          { $set: { status: "unknown", checkedAt: clock.now() } },
          atLeast,
        );
        return;
      }
      throw error;
    }
  }

  async function recoverOrCreateRefund(intent) {
    if (intent.status === "unknown") {
      const result = await client.listRefunds(intent._id);
      if (!Array.isArray(result.items)) throw mismatch();
      const matches = result.items.filter(
        ({ receipt }) => receipt === intent.receipt,
      );
      if (matches.length > 1) throw mismatch();
      if (matches.length) return matches[0];
    }
    // After a crash, reconcile by receipt before retrying an external refund.
    await GatewayRefund.updateOne(
      { _id: intent._id, status: "requested" },
      { $set: { status: "unknown" } },
      atLeast,
    );
    return client.createRefund(
      intent._id,
      { amount: intent.amount, speed: "normal", receipt: intent.receipt },
      intent.receipt,
    );
  }

  async function checkOrder(record) {
    try {
      if (!record.gatewayOrderId) {
        await reconcileMapping(record);
        return;
      }
      const result = await client.listPayments(record.gatewayOrderId);
      if (!Array.isArray(result.items)) throw unavailable();
      const captured = result.items.filter(
        (entity) => entity.status === "captured",
      );
      for (const entity of captured) await payment(record, entity, entity.id);
    } catch (error) {
      if (
        !(error instanceof RazorpayRequestError) &&
        error.code !== "GATEWAY_UNAVAILABLE" &&
        error.code !== "GATEWAY_PAYMENT_MISMATCH"
      )
        throw error;
    }
  }

  async function maintain() {
    if (working) return;
    working = true;
    try {
      // Move the due time before I/O, so competing workers or a restart can resume safely.
      const due = { $type: "date", $lte: clock.now() };
      const intent = await GatewayRefund.findOneAndUpdate(
        { nextCheckAt: due },
        { $set: { nextCheckAt: next(clock, 30_000) } },
        { ...atLeast, sort: { nextCheckAt: 1 }, new: true },
      ).lean();
      if (intent) await refund(intent);
      const record = await GatewayOrder.findOneAndUpdate(
        { nextCheckAt: due },
        { $set: { nextCheckAt: next(clock, 60_000) } },
        { ...atLeast, sort: { nextCheckAt: 1 }, new: true },
      ).lean();
      if (record) await checkOrder(record);
    } finally {
      working = false;
    }
  }

  return { begin, verifyCheckout, webhook, maintain };
}

export async function readRazorpayStatus(
  { GatewayAttempt, GatewayRefund, GatewayOrder },
  order,
  settled,
) {
  const [mapping, attempt, intent] = await Promise.all([
    GatewayOrder.exists({ _id: order._id, submittedAt: { $type: "date" } }),
    GatewayAttempt.findOne({ orderId: order._id })
      .sort({ checkedAt: -1 })
      .select("status")
      .lean(),
    settled?.gatewayPaymentId
      ? GatewayRefund.findById(settled.gatewayPaymentId)
          .select("reason status checkedAt")
          .lean()
      : null,
  ]);
  return {
    status:
      settled?.status === "processed"
        ? "processed"
        : intent
          ? "refund_required"
          : "pending",
    hasAttempt: Boolean(mapping),
    ...(attempt && { gatewayStatus: attempt.status }),
    ...(intent && {
      refund: {
        status: intent.status,
        reason: intent.reason,
        checkedAt: intent.checkedAt,
      },
    }),
  };
}

function checkDuplicate(event, bodyHash) {
  if (event?.bodyHash !== bodyHash)
    throw fail(
      409,
      "GATEWAY_EVENT_CONFLICT",
      "The gateway event identifier was used for a different delivery.",
    );
}

export function startRazorpayJobs(gateway, report) {
  const timer = setInterval(() => {
    void gateway.maintain().catch(report);
  }, 5000).unref();
  return () => clearInterval(timer);
}
