import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createRequire } from "node:module";
import { systemClock } from "./lib/clock.js";
import { createDbStatus } from "./health/db-smoke.js";
import { streamHealth } from "./health/sse.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

function sendError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createApp({
  clientOrigins,
  clock = systemClock,
  dbStatus = createDbStatus(),
}) {
  const app = express();
  const allowedOrigins = new Set(clientOrigins);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store").vary("Origin");
    const origin = request.get("Origin");
    if (origin && !allowedOrigins.has(origin)) {
      return sendError(
        response,
        403,
        "CORS_ORIGIN_DENIED",
        "This browser origin is not allowed.",
      );
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, origin && allowedOrigins.has(origin) ? origin : false),
      methods: ["GET", "HEAD"],
      allowedHeaders: ["Authorization"],
    }),
  );

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "QueueTix",
      version,
      time: clock.now().toISOString(),
    });
  });
  app.get("/health/db", (_request, response) => {
    const result = dbStatus.read();
    response.status(result.ok ? 200 : 503).json(result);
  });
  app.get("/health/sse", (request, response) => {
    if (request.method === "HEAD")
      return response.type("text/event-stream").end();
    streamHealth(response, clock);
  });
  app.get("/health/cors", (request, response) => {
    if (!request.get("Authorization")) {
      return sendError(
        response,
        400,
        "AUTHORIZATION_HEADER_REQUIRED",
        "Send an Authorization header for this check.",
      );
    }
    response.json({ ok: true });
  });

  app.use((_request, response) =>
    sendError(response, 404, "NOT_FOUND", "Endpoint not found."),
  );
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    sendError(
      response,
      500,
      "INTERNAL_ERROR",
      "The service could not complete the request.",
    );
  });
  return app;
}
