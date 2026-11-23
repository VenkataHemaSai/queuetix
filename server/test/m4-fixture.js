import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createFakeClock } from "../src/lib/clock.js";
import { connectMongo } from "../src/lib/db.js";
import { initializeModels } from "../src/modules/models.js";
import { createQueueRuntime } from "../src/modules/queue/index.js";
import { buildLayout, layoutSeats } from "../../shared/seat-layout.js";

export const env = {
  nodeEnv: "test",
  jwtSecret: "fixture-m4-session-key-local-only",
  paymentWebhookSecret: "fixture-m4-mock-signature-local-only",
  qrHmacSecret: "fixture-m4-ticket-signature-local-only",
};
export const newId = () => new Types.ObjectId();
const layout = buildLayout("bus", { standard: 19999 });

export async function testDatabase(name) {
  const replica = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  const connection = await connectMongo(replica.getUri(name));
  try {
    const models = await initializeModels(connection);
    return {
      models,
      connection,
      async close() {
        await connection.close();
        await replica.stop();
      },
    };
  } catch (error) {
    await connection.close();
    await replica.stop();
    throw error;
  }
}

export async function fixture({ models, connection }, overrides = {}) {
  const clock = createFakeClock("2026-11-23T08:00:00Z");
  const config = { ...env, ...overrides.env };
  const runtime = createQueueRuntime({
    ...models,
    connection,
    clock,
    ...config,
  });
  async function user(role = "attendee") {
    return models.User.create({
      role,
      name: "Fixture " + role,
      email: newId() + "@fixture.invalid",
    });
  }
  const owner = await user("organizer");
  const event = await models.Event.create({
    organizerId: owner._id,
    title: "Fixture sale",
    description: "Disposable screening",
    venue: "Local",
    type: "bus",
    layout,
    timeZone: "UTC",
    currency: "INR",
    status: "on_sale",
    nextNumber: 1,
    totalSeats: 4,
    saleStartsAt: new Date(+clock.now() - 60_000),
    lobbyOpensAt: new Date(+clock.now() - 600_000),
    startsAt: new Date(+clock.now() + 86_400_000),
    ...overrides.event,
  });
  const seats = overrides.noSeats
    ? []
    : await models.Seat.insertMany(
        layoutSeats(layout)
          .slice(0, 4)
          .map((seat) => ({ ...seat, eventId: event._id })),
      );
  const { booking, queue } = runtime;
  async function place(userId, seat = seats[0], key = String(newId())) {
    const hold = await booking.createHold(event._id, userId, [seat._id], key);
    const order = await booking.createOrder(event._id, userId, hold._id, key);
    return { hold, order };
  }
  async function begin(userId, seat, key) {
    await booking.issuePass(event._id, userId);
    return place(userId, seat, key);
  }
  const api = request(
    createApp({
      clientOrigins: [],
      clock,
      features: {
        models,
        connection,
        env: config,
        booking,
        queue,
        razorpay: overrides.razorpay?.({ models, booking, clock }),
      },
    }),
  );
  function auth(account) {
    const now = Math.floor(+clock.now() / 1000);
    return (
      "Bearer " +
      jwt.sign({ iat: now, exp: now + 3600 }, config.jwtSecret, {
        algorithm: "HS256",
        issuer: "QueueTix",
        audience: "queuetix-api",
        subject: String(account._id),
      })
    );
  }
  return {
    ...runtime,
    api,
    auth,
    user,
    owner,
    clock,
    event,
    seats,
    models,
    begin,
    place,
  };
}
