import { Router } from "express";
import { HttpError } from "../lib/http.js";
import { authRoutes, requireSession } from "./auth/auth.routes.js";
import { createAuthService } from "./auth/auth.service.js";
import { eventRoutes } from "./events/event.routes.js";
import { createEventService } from "./events/event.service.js";

export function featureRoutes(
  { models, connection, env, verifyGoogle },
  clock,
) {
  const router = Router();
  if (!models) {
    router.use(["/auth", "/me", "/events", "/organizer/events"], () => {
      throw new HttpError(
        503,
        "DB_UNAVAILABLE",
        "The service is temporarily unavailable. Try again shortly.",
      );
    });
    return router;
  }
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
  return router;
}
