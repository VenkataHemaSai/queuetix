import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createRequire } from "node:module";
import { systemClock } from "./lib/clock.js";
import { createDbStatus } from "./health/db-smoke.js";
import { streamHealth } from "./health/sse.js";
import { HttpError } from "./lib/http.js";
import { featureRoutes } from "./modules/features.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

function sendError(response, status, code, message, fields) {
  return response
    .status(status)
    .json({ error: { code, message, ...(fields && { fields }) } });
}

export function createApp({
  clientOrigins,
  clock = systemClock,
  dbStatus = createDbStatus(),
  features,
}) {
  const app = express();
  const allowedOrigins = new Set(clientOrigins);
  const appReady = Boolean(features?.models);
  app.disable("x-powered-by");
  app.set("trust proxy", features?.env.trustProxy ?? 0);
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
    cors((request, callback) => {
      const featureRequest =
        features && !/^\/health(?:\/|$)/.test(request.path);
      const origin = request.get("Origin");
      callback(null, {
        origin: allowedOrigins.has(origin) ? origin : false,
        methods: featureRequest
          ? ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]
          : ["GET", "HEAD"],
        allowedHeaders: featureRequest
          ? ["Authorization", "Content-Type"]
          : ["Authorization"],
        ...(featureRequest && { exposedHeaders: ["Retry-After"] }),
      });
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
  app.get("/health/ready", (_request, response) => {
    if (appReady) return response.json({ ok: true });
    response.status(503).json({ ok: false, code: "APP_NOT_READY" });
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

  if (features) app.use(featureRoutes(features, clock));

  app.use((_request, response) =>
    sendError(response, 404, "NOT_FOUND", "Endpoint not found."),
  );
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof HttpError)
      return sendError(
        response,
        error.status,
        error.code,
        error.message,
        error.fields,
      );
    if (error.type === "entity.parse.failed")
      return sendError(response, 400, "INVALID_JSON", "Send valid JSON.");
    if (error.type === "entity.too.large")
      return sendError(
        response,
        413,
        "BODY_TOO_LARGE",
        "Request body is too large.",
      );
    if (error.type === "encoding.unsupported")
      return sendError(
        response,
        415,
        "UNSUPPORTED_ENCODING",
        "Send an uncompressed request.",
      );
    if (error.code === "TXN_COMMIT_UNCONFIRMED") {
      return sendError(
        response,
        503,
        error.code,
        "The result could not be confirmed. Reload this event before continuing.",
      );
    }
    if (
      error.code === "TXN_RETRIES_EXHAUSTED" ||
      error.code === "DB_DEADLINE_EXCEEDED" ||
      [
        "MongooseServerSelectionError",
        "MongoServerSelectionError",
        "MongoOperationTimeoutError",
        "MongoNetworkError",
        "MongoNetworkTimeoutError",
      ].includes(error.name)
    ) {
      return sendError(
        response,
        503,
        "DB_UNAVAILABLE",
        "The service is temporarily unavailable. Try again shortly.",
      );
    }
    sendError(
      response,
      500,
      "INTERNAL_ERROR",
      "The service could not complete the request.",
    );
  });
  return app;
}
