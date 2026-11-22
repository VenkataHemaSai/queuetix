import { once } from "node:events";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import { readEnv } from "./config/env.js";
import {
  createDbStatus,
  dbUnavailable,
  runDbSmoke,
} from "./health/db-smoke.js";
import { systemClock as clock } from "./lib/clock.js";
import { connectMongo } from "./lib/db.js";
import { mongoDiagnostic } from "./lib/diagnostic.js";
import { initializeModels } from "./modules/models.js";
import { createBooking } from "./modules/booking/index.js";
import { startExpirySweeper } from "./modules/booking/sweeper.js";

async function start() {
  try {
    loadEnvFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not load server/.env.");
  }
  const env = readEnv(process.env);
  const dbStatus = createDbStatus();
  const started = performance.now();
  const reportFailure = (failure) =>
    console.error("QueueTix database probe failed", JSON.stringify(failure));
  let connection;
  try {
    connection = await connectMongo(env.mongoUri);
  } catch (error) {
    reportFailure({
      stage: "connect",
      ...mongoDiagnostic(error, env.mongoUri),
    });
    dbStatus.store(
      dbUnavailable(clock, Math.round(performance.now() - started)),
    );
  }
  let models;
  if (connection) {
    dbStatus.store(
      await runDbSmoke({
        connection,
        clock,
        mongoUri: env.mongoUri,
        reportFailure,
      }),
    );
    if (dbStatus.read().ok) {
      try {
        models = await initializeModels(connection);
      } catch (error) {
        reportFailure({
          stage: "initialize models",
          ...mongoDiagnostic(error, env.mongoUri),
        });
      }
    }
    if (!models) await connection.close().catch(() => {});
  }
  console.info("QueueTix database probe", JSON.stringify(dbStatus.read()));
  const booking =
    models && createBooking({ ...models, connection, clock, ...env });
  const app = createApp({
    clientOrigins: env.clientOrigins,
    clock,
    dbStatus,
    features: { connection, models, env, booking },
  });
  const host = env.nodeEnv === "production" ? "0.0.0.0" : "localhost";
  const server = app.listen(env.port, host);
  await once(server, "listening");
  if (booking) {
    const timer = startExpirySweeper(booking.sweepExpired, (error) => {
      console.error(
        "QueueTix expiry sweep failed",
        JSON.stringify(mongoDiagnostic(error, env.mongoUri)),
      );
    });
    server.once("close", () => clearInterval(timer));
  }
  console.info(`QueueTix API listening on port ${env.port}`);
}

start().catch((error) => {
  console.error("QueueTix startup failed", mongoDiagnostic(error));
  process.exitCode = 1;
});
