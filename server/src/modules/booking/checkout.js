import {
  alreadyBooked,
  fail,
  missingOrder,
  newId,
  sameRequest,
} from "./rules.js";
import { fingerprint, signTicketPayload } from "./signatures.js";

class Refund extends Error {}

const pending = { status: "pending" };
const active = { status: "active" };
const holdExpired = () =>
  fail(409, "HOLD_EXPIRED", "This hold is no longer available for checkout.");

export function createCheckout({
  Event,
  Seat,
  Hold,
  Pass,
  Quota,
  Order,
  OrderKey,
  Payment,
  GatewayRefund,
  Ticket,
  AuditLog,
  transaction,
  retireHold,
  qrHmacSecret,
  paymentProvider = "mock",
  clock,
  queueEntries,
  publish,
}) {
  async function orderForKey(scope, signature, session = null) {
    const record = await OrderKey.findOne(scope).session(session).lean();
    if (!record) return null;
    return Order.findById(sameRequest(record, signature).orderId)
      .session(session)
      .lean();
  }

  async function createOrder(eventId, userId, holdId, idempotencyKey) {
    const owner = { eventId, userId };
    const scope = { userId, idempotencyKey };
    const requestFingerprint = fingerprint([
      String(eventId).toLowerCase(),
      String(holdId).toLowerCase(),
    ]);

    const work = async ({ session, now }) => {
      const replay = await orderForKey(scope, requestFingerprint, session);
      if (replay) return replay;
      // Serialize checkout with hold replacement, retirement and payment for this owner.
      const quota = await Quota.findOneAndUpdate(
        owner,
        { $inc: { revision: 1 } },
        { session, new: true },
      ).lean();
      if (!quota) throw holdExpired();
      let order = await Order.findOne({ ...owner, holdId })
        .session(session)
        .lean();
      if (!order) {
        if (quota.bought) throw alreadyBooked();
        const hold = await Hold.findOne({
          ...owner,
          _id: holdId,
          ...active,
          expiresAt: { $gt: now },
        })
          .session(session)
          .lean();
        if (!hold) throw holdExpired();
        const seats = await Seat.find({
          eventId,
          _id: { $in: hold.seatIds },
          status: "held",
          holdId,
        })
          .sort("seatIndex")
          .session(session)
          .lean();
        if (seats.length !== hold.seatIds.length) throw holdExpired();
        const event = await Event.findById(eventId)
          .select("currency")
          .session(session)
          .lean();
        const [created] = await Order.create(
          [
            {
              ...owner,
              holdId,
              passId: hold.passId,
              holdExpiresAt: hold.expiresAt,
              seatIds: seats.map(({ _id }) => _id),
              seatLines: seats.map(({ _id, label, section, tier, price }) => ({
                seatId: _id,
                label,
                section,
                tier,
                price,
              })),
              amount: seats.reduce((total, { price }) => total + price, 0),
              currency: event.currency,
              paymentProvider,
              idempotencyKey,
              requestFingerprint,
            },
          ],
          { session },
        );
        order = created.toObject();
      }
      await OrderKey.create(
        [{ ...owner, orderId: order._id, idempotencyKey, requestFingerprint }],
        { session },
      );
      return order;
    };
    try {
      return await transaction(work);
    } catch (error) {
      if (error.code !== 11000) throw error;
      return (
        (await orderForKey(scope, requestFingerprint)) ?? transaction(work)
      );
    }
  }

  async function getOrder(orderId, userId) {
    const order = await Order.findOne({ _id: orderId, userId }).lean();
    if (!order) throw missingOrder();
    return order;
  }

  async function checkoutState(order) {
    const now = clock.now();
    const holdActive =
      order.status === "pending" &&
      Boolean(
        await Hold.exists({
          _id: order.holdId,
          status: "active",
          expiresAt: { $gt: now },
        }),
      );
    return { holdActive, serverTime: now.toISOString() };
  }

  async function paymentRequest(input, session = null) {
    const order = await Order.findById(input.orderId).session(session).lean();
    if (!order) throw missingOrder();
    if ((order.paymentProvider ?? "mock") !== (input.provider ?? "mock"))
      throw fail(
        409,
        "PAYMENT_PROVIDER_MISMATCH",
        "This order uses a different payment provider.",
      );
    const amount = input.amount ?? order.amount;
    const requestFingerprint = fingerprint([
      String(order._id),
      input.outcome,
      amount,
    ]);
    const payment = await Payment.findOne({ providerRef: input.providerRef })
      .session(session)
      .lean();
    return {
      order,
      amount,
      requestFingerprint,
      payment: payment && sameRequest(payment, requestFingerprint),
    };
  }

  function paymentData(input, order, amount, requestFingerprint, now) {
    return {
      eventId: order.eventId,
      orderId: order._id,
      providerRef: input.providerRef,
      provider: input.provider ?? "mock",
      gatewayPaymentId: input.gatewayPaymentId,
      currency: order.currency,
      requestFingerprint,
      outcome: input.outcome,
      amount,
      processedAt: now,
    };
  }

  async function closeOrder(order, values, { session, now }) {
    const closed = await Order.findOneAndUpdate(
      { _id: order._id, ...pending },
      { $set: values },
      { new: true, session },
    ).lean();
    if (!closed) throw new Error("Order state changed during confirmation.");
    await AuditLog.create(
      [
        {
          eventId: order.eventId,
          userId: order.userId,
          orderId: order._id,
          action: `order.${values.status}`,
          at: now,
        },
      ],
      { session },
    );
    return closed;
  }

  async function succeed(order, amount, txn) {
    const { session, now, afterCommit } = txn;
    const { _id: orderId, eventId, userId, holdId, passId, seatIds } = order;
    if (order.status === "paid") throw new Refund("duplicate_payment");
    if (order.status !== "pending") throw new Refund("order_closed");
    const event = await Event.findById(eventId)
      .select("status startsAt")
      .session(session)
      .lean();
    if (event.status === "ended") throw new Refund("event_ended");
    if (queueEntries && event.startsAt <= now) {
      await Event.updateOne(
        { _id: eventId, status: event.status },
        { $inc: { queueRevision: 1 } },
        { session },
      );
    }
    const owner = { eventId, userId };
    const otherHold = await Hold.findOne({
      ...owner,
      ...active,
      _id: { $ne: holdId },
    })
      .select("expiresAt")
      .session(session)
      .lean();
    if (otherHold?.expiresAt > now) throw new Refund("superseded");
    if (amount !== order.amount) throw new Refund("amount_mismatch");
    if (otherHold) await retireHold(otherHold._id, "expired", txn);
    const hold = await Hold.findOneAndUpdate(
      { ...owner, _id: holdId, status: { $in: ["active", "expired"] } },
      { $set: { status: "converted" } },
      { session },
    ).lean();
    if (!hold) throw new Refund("hold_released");
    const sold = await Seat.updateMany(
      {
        eventId,
        _id: { $in: seatIds },
        $or: [{ status: "held", holdId }, { status: "available" }],
      },
      { $set: { status: "sold", orderId, holdId: null, holdExpiresAt: null } },
      { session },
    );
    if (sold.modifiedCount !== seatIds.length)
      throw new Refund("seats_unavailable");
    const count = seatIds.length;
    const held = hold.status === "active" ? count : 0;
    const quota = await Quota.updateOne(
      { ...owner, bought: 0, held: { $gte: held } },
      { $inc: { bought: count, held: -held } },
      { session },
    );
    if (!quota.matchedCount) throw new Refund("already_booked");
    await Ticket.insertMany(
      seatIds.map((seatId) => {
        const _id = newId();
        return {
          _id,
          ...owner,
          orderId,
          seatId,
          issuedAt: now,
          qrPayload: signTicketPayload(_id, qrHmacSecret),
        };
      }),
      { session },
    );
    const paid = await closeOrder(order, { status: "paid" }, txn);
    const pass = await Pass.updateOne(
      { ...owner, _id: passId, status: { $in: ["active", "expired"] } },
      { $set: { status: "used" } },
      { session },
    );
    if (!pass.matchedCount)
      throw new Error("Order admission reference is inconsistent.");
    // A later unused pass closes separately. Only the order's recorded pass is used.
    await Pass.updateMany(
      { ...owner, ...active, _id: { $ne: passId } },
      { $set: { status: "expired" } },
      { session },
    );
    if (queueEntries)
      await queueEntries.updateOne(
        {
          ...owner,
          status: {
            $in: [
              "waiting",
              "abandoned",
              "expired",
              "admitted",
              "expired_soldout",
            ],
          },
        },
        { $set: { status: "completed" } },
        { session },
      );
    if (publish)
      afterCommit(() => publish(eventId, "seat:sold", { userId, seatIds }));
    return paid;
  }

  async function recordCallback(input, txn) {
    const { session, now } = txn;
    const { order, payment, amount, requestFingerprint } = await paymentRequest(
      input,
      session,
    );
    if (payment) return { order, payment };
    const [record] = await Payment.create(
      [
        {
          ...paymentData(input, order, amount, requestFingerprint, now),
          status: input.outcome === "failed" ? "failed" : "processed",
          ...(input.outcome === "failed" && { reason: "payment_failed" }),
        },
      ],
      { session },
    );
    if (input.outcome === "succeeded")
      return {
        order: await succeed(order, amount, txn),
        payment: record.toObject(),
      };
    if (order.status !== "pending")
      return { order, payment: record.toObject() };
    const closed = await closeOrder(
      order,
      { status: "failed", failureReason: "payment_failed" },
      txn,
    );
    await retireHold(order.holdId, "released", txn);
    return { order: closed, payment: record.toObject() };
  }

  async function recordRefund(input, reason, txn) {
    const { session, now } = txn;
    const { order, payment, amount, requestFingerprint } = await paymentRequest(
      input,
      session,
    );
    if (payment) return { order, payment };
    const refundReason =
      order.status === "paid"
        ? "duplicate_payment"
        : order.status === "failed"
          ? "order_closed"
          : reason;
    const [record] = await Payment.create(
      [
        {
          ...paymentData(input, order, amount, requestFingerprint, now),
          status: "refunded",
          reason: refundReason,
        },
      ],
      { session },
    );
    if (input.provider === "razorpay") {
      const receipt =
        "qt_rf_" + fingerprint([input.gatewayPaymentId]).slice(0, 32);
      await GatewayRefund.create(
        [
          {
            _id: input.gatewayPaymentId,
            orderId: order._id,
            receipt,
            amount,
            currency: order.currency,
            reason: refundReason,
            status: "requested",
            nextCheckAt: now,
          },
        ],
        { session },
      );
    }
    const closed =
      order.status === "pending"
        ? await closeOrder(
            order,
            { status: "failed", failureReason: refundReason },
            txn,
          )
        : order;
    return { order: closed, payment: record.toObject() };
  }

  async function settle(input, work) {
    try {
      return await transaction(work);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const replay = await paymentRequest(input);
      if (replay.payment)
        return { order: replay.order, payment: replay.payment };
      throw error;
    }
  }

  async function confirmPayment(input) {
    try {
      return await settle(input, (txn) => recordCallback(input, txn));
    } catch (error) {
      if (!(error instanceof Refund)) throw error;
      return settle(input, (txn) => recordRefund(input, error.message, txn));
    }
  }

  return { createOrder, getOrder, checkoutState, confirmPayment };
}
