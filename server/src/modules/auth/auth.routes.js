import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { HttpError, validate } from "../../lib/http.js";

const credential = z.strictObject({ credential: z.string().min(1).max(8192) });
const empty = z.strictObject({});

export function requireSession(auth) {
  return async (request, _response, next) => {
    request.user = await auth.authenticate(request.get("Authorization"));
    next();
  };
}

export function requireRole(role) {
  return (request, _response, next) => {
    if (request.user.role !== role || request.user.isGuest) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "This account does not have access.",
      );
    }
    next();
  };
}

function signInLimit(limit) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) =>
      next(
        new HttpError(
          429,
          "RATE_LIMITED",
          "Too many sign-in attempts. Try again shortly.",
        ),
      ),
  });
}

export function authRoutes(auth, session) {
  const router = Router();
  router.post("/auth/google", signInLimit(30), async (request, response) => {
    response.json(
      await auth.signInGoogle(validate(credential, request.body).credential),
    );
  });
  router.post("/auth/demo", signInLimit(5), async (request, response) => {
    validate(empty, request.body ?? {});
    response.json(await auth.signInDemo(request.get("Authorization")));
  });
  router.get("/me", session, (request, response) => {
    response.json({ user: auth.publicUser(request.user) });
  });
  return router;
}
