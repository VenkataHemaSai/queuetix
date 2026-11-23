import express, { Router } from "express";
import { HttpError } from "../lib/http.js";
import { authRoutes, requireSession } from "./auth/auth.routes.js";
import { createAuthService } from "./auth/auth.service.js";
import { eventRoutes } from "./events/event.routes.js";
import { createEventService } from "./events/event.service.js";
import { createBooking } from "./booking/index.js";
import { bookingRoutes, bookingWebhooks } from "./booking/routes.js";
import { queueRoutes } from "./queue/routes.js";

export function featureRoutes(
  { models, connection, env, verifyGoogle, booking: initializedBooking, queue },
  clock,
) {
  const router = Router();
  const bookingConfigured =
    models && env.paymentWebhookSecret && env.qrHmacSecret;
  const devTools =
    bookingConfigured && env.nodeEnv === "development" && env.enableDevTools;
  if (!devTools)
    router.all("/dev/issue-pass", () => {
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    });
  if (!models) {
    router.use(
      [
        "/auth",
        "/me",
        "/events",
        "/organizer/events",
        "/orders",
        "/tickets",
        "/payments",
        "/stream",
      ],
      () => {
        throw new HttpError(
          503,
          "DB_UNAVAILABLE",
          "The service is temporarily unavailable. Try again shortly.",
        );
      },
    );
    return router;
  }
  const booking =
    bookingConfigured &&
    (initializedBooking ??
      createBooking({ ...models, connection, clock, ...env }));
  const mock =
    booking && bookingWebhooks(router, booking, env.paymentWebhookSecret);
  router.use(express.json({ limit: "24kb" }));
  const auth = createAuthService({
    User: models.User,
    clock,
    ...env,
    verifyGoogle,
  });
  const session = requireSession(auth);
  router.use(authRoutes(auth, session));
  router.use(
    eventRoutes(createEventService({ ...models, connection, clock }), session),
  );
  if (booking) router.use(bookingRoutes(booking, session, mock, devTools));
  if (booking && queue) router.use(queueRoutes(queue, booking, session));
  return router;
}
