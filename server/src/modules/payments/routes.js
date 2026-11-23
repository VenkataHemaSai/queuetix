import express, { Router } from "express";
import { z } from "zod";
import { validate } from "../../lib/http.js";
import { requestLimit } from "../../lib/rate-limit.js";
import { eventId } from "../events/event.validation.js";
import { fail } from "../booking/rules.js";
import { checkoutResult } from "./razorpay.js";

export function registerRazorpayWebhook(router, gateway) {
  router.post(
    "/payments/razorpay/webhook",
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    async (req, res) => {
      await gateway.webhook(
        req.body,
        req.get("X-Razorpay-Signature"),
        req.get("X-Razorpay-Event-Id"),
      );
      res.json({ received: true });
    },
  );
}

const empty = z.strictObject({});
export function razorpayRoutes(gateway, booking, session, clock) {
  const router = Router();
  const attemptLimit = requestLimit(clock, {
    limit: 20,
    key: (req) => String(req.user._id),
    message:
      "Too many payment requests. Check your booking status and try again shortly.",
  });
  router.use(
    "/orders/:id/razorpay",
    session,
    (req, _res, next) => {
      if (req.user.role !== "attendee")
        throw fail(403, "FORBIDDEN", "An attendee account is required.");
      next();
    },
    attemptLimit,
  );

  router.post("/orders/:id/razorpay", async (req, res) => {
    validate(empty, req.body ?? {});
    const order = await booking.getOrder(
      validate(eventId, req.params.id),
      req.user._id,
    );
    res.json({ checkout: await gateway.begin(order) });
  });

  router.post("/orders/:id/razorpay/verify", async (req, res) => {
    const input = validate(checkoutResult, req.body);
    const order = await booking.getOrder(
      validate(eventId, req.params.id),
      req.user._id,
    );
    await gateway.verifyCheckout(order, input);
    res.json({ received: true });
  });
  return router;
}
