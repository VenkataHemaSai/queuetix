import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { validate } from "../../lib/http.js";
import { eventId, pageInput } from "../events/event.validation.js";
import { fail } from "./rules.js";
import { signPayload, validSignature } from "./signatures.js";

const key = z.string().trim().min(1).max(128);
const seatIds = z.array(eventId).min(1).max(4);
const eventInput = z.strictObject({ eventId });
const releaseInput = z.strictObject({ holdId: eventId });
const holdInput = z.strictObject({ seatIds, idempotencyKey: key });
const replacementInput = z.strictObject({ seatIds, holdId: eventId });
const orderInput = z.strictObject({
  eventId,
  holdId: eventId,
  idempotencyKey: key,
});
const outcome = z.enum(["succeeded", "failed"]);
const payInput = z.strictObject({ outcome });
const webhookInput = z.strictObject({
  orderId: eventId,
  outcome,
  providerRef: key,
  amount: z.number().int().min(0).max(400_000_000).optional(),
});
const suggestInput = z.strictObject({
  tier: z.string().min(1).max(32),
  count: z.coerce.number().int().min(1).max(4),
});

export function holdView(hold) {
  return (
    hold && {
      id: String(hold._id),
      expiresAt: hold.expiresAt,
      seatIds: hold.seatIds,
      status: hold.status,
      seats: hold.seats,
    }
  );
}

export function orderView(order) {
  return (
    order && {
      id: String(order._id),
      eventId: String(order.eventId),
      holdId: String(order.holdId),
      seats: order.seatLines,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      holdExpiresAt: order.holdExpiresAt,
      failureReason: order.failureReason,
    }
  );
}

function paymentView(payment) {
  return (
    payment && {
      status: payment.status,
      reason: payment.reason,
      processedAt: payment.processedAt,
    }
  );
}

export function bookingWebhooks(router, booking, secret) {
  async function receive(raw, signature) {
    if (!Buffer.isBuffer(raw) || !validSignature(raw, signature, secret)) {
      throw fail(
        401,
        "INVALID_WEBHOOK_SIGNATURE",
        "The payment signature is invalid.",
      );
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw fail(400, "INVALID_JSON", "Send valid JSON.");
    }
    const result = await booking.confirmPayment(
      validate(webhookInput, payload),
    );
    return {
      order: orderView(result.order),
      payment: paymentView(result.payment),
    };
  }

  router.post(
    "/payments/mock/webhook",
    express.raw({ type: "application/json", limit: "8kb", inflate: false }),
    async (request, response) =>
      response.json(
        await receive(request.body, request.get("X-Mock-Signature")),
      ),
  );

  return function mockCallback(order, outcome) {
    const raw = Buffer.from(
      JSON.stringify({
        orderId: String(order._id),
        providerRef: `mock:${order._id}`,
        amount: order.amount,
        outcome,
      }),
    );
    return receive(raw, signPayload(raw, secret));
  };
}

export function bookingRoutes(booking, session, mockCallback, devTools) {
  const router = Router();
  const user = (request) => request.user._id;
  const id = (request) => validate(eventId, request.params.id);
  const attendee = [
    session,
    (request, _response, next) => {
      if (request.user.role !== "attendee")
        throw fail(403, "FORBIDDEN", "An attendee account is required.");
      next();
    },
  ];
  const holdLimit = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) => String(user(request)),
    handler: (_request, _response, next) =>
      next(
        fail(429, "RATE_LIMITED", "Too many hold changes. Try again shortly."),
      ),
  });

  if (devTools)
    router.post("/dev/issue-pass", attendee, async (request, response) => {
      const { eventId } = validate(eventInput, request.body);
      const pass = await booking.issuePass(eventId, user(request));
      response.json({ pass: { expiresAt: pass.expiresAt } });
    });
  router.get("/events/:id/booking", attendee, async (request, response) => {
    const { pass, hold, order, maxSeatsPerUser, serverTime } =
      await booking.bookingState(id(request), user(request));
    response.json({
      pass: pass && { expiresAt: pass.expiresAt },
      hold: holdView(hold),
      order: orderView(order),
      maxSeatsPerUser,
      serverTime,
    });
  });
  router.get("/events/:id/seats", attendee, async (request, response) => {
    response.json({
      seats: await booking.listSeats(id(request), user(request)),
    });
  });
  router.get(
    "/events/:id/best-available",
    attendee,
    async (request, response) => {
      const { tier, count } = validate(suggestInput, request.query);
      response.json(
        await booking.bestAvailable(id(request), user(request), tier, count),
      );
    },
  );
  router.post(
    "/events/:id/holds",
    attendee,
    holdLimit,
    async (request, response) => {
      const { seatIds, idempotencyKey } = validate(holdInput, request.body);
      response.json({
        hold: holdView(
          await booking.createHold(
            id(request),
            user(request),
            seatIds,
            idempotencyKey,
          ),
        ),
      });
    },
  );
  router.put(
    "/events/:id/holds/current",
    attendee,
    holdLimit,
    async (request, response) => {
      const { holdId, seatIds } = validate(replacementInput, request.body);
      response.json({
        hold: holdView(
          await booking.replaceHold(
            id(request),
            user(request),
            holdId,
            seatIds,
          ),
        ),
      });
    },
  );
  router.delete(
    "/events/:id/holds/current",
    attendee,
    holdLimit,
    async (request, response) => {
      const { holdId } = validate(releaseInput, request.body);
      response.json({
        hold: holdView(
          await booking.releaseHold(id(request), user(request), holdId),
        ),
      });
    },
  );
  router.post("/orders", attendee, async (request, response) => {
    const { eventId, holdId, idempotencyKey } = validate(
      orderInput,
      request.body,
    );
    response.json({
      order: orderView(
        await booking.createOrder(
          eventId,
          user(request),
          holdId,
          idempotencyKey,
        ),
      ),
    });
  });
  router.get("/orders/:id", attendee, async (request, response) => {
    const order = await booking.getOrder(id(request), user(request));
    const [payment, checkout] = await Promise.all([
      booking.lastPayment(order._id),
      booking.checkoutState(order),
    ]);
    response.json({
      order: orderView(order),
      payment: paymentView(payment),
      ...checkout,
    });
  });
  router.post("/orders/:id/mock", attendee, async (request, response) => {
    const { outcome } = validate(payInput, request.body);
    const order = await booking.getOrder(id(request), user(request));
    if (
      order.status === "pending" &&
      !(await booking.checkoutState(order)).holdActive
    ) {
      throw fail(409, "HOLD_EXPIRED", "The hold ended before payment began.");
    }
    response.json(await mockCallback(order, outcome));
  });
  router.get("/tickets/my", attendee, async (request, response) => {
    const { page, limit } = validate(pageInput, request.query);
    response.json(await booking.myTickets(user(request), page, limit));
  });
  return router;
}
