import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { systemClock as clock } from "../../server/src/lib/clock.js";
import { createApp } from "../../server/src/app.js";
import {
  seedFixture,
  simulationRuntime,
  pool,
  latency,
  digest,
} from "../../server/src/modules/simulation/fixture.js";
import { cleanFixture } from "../../server/src/modules/simulation/service.js";
import { assertSimulationStore } from "../../server/src/modules/simulation/scope.js";

export async function runHttp({ models, connection, config }) {
  assertSimulationStore(models, connection);
  const start = performance.now(),
    runId = randomUUID(),
    eventId = new Types.ObjectId();
  const env = {
    jwtSecret: randomUUID(),
    paymentWebhookSecret: randomUUID(),
    qrHmacSecret: randomUUID(),
    nodeEnv: "test",
  };
  let server,
    base,
    open = 0,
    peak = 0,
    connectionFailures = 0,
    reconnections = 0,
    completedUsers = 0,
    expected429 = 0,
    failedPayments = 0;
  const codes = {},
    joins = [],
    holds = [],
    streams = new Set(),
    unexpectedErrors = [],
    admissions = [];
  const tokens = new Map();
  const count = (status) => {
    codes[status] = (codes[status] ?? 0) + 1;
  };
  async function request(id, path, body, limited = false) {
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: tokens.get(String(id)),
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    count(res.status);
    const data = await res.json();
    if (
      limited &&
      res.status === 429 &&
      Number(res.headers.get("Retry-After")) > 0 &&
      data.error.code === "RATE_LIMITED"
    ) {
      expected429++;
      return null;
    }
    if (!res.ok)
      throw Error(path + " returned " + res.status + " " + data.error?.code);
    return data;
  }
  async function connect(id) {
    const controller = new AbortController();
    const entry = { controller, id };
    streams.add(entry);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(base + "/stream/queue/" + eventId, {
        headers: { Authorization: tokens.get(String(id)) },
        signal: controller.signal,
      });
      count(res.status);
      if (
        res.status !== 200 ||
        !res.headers.get("content-type")?.includes("text/event-stream")
      )
        throw Error("Queue stream rejected.");
      const reader = res.body.getReader();
      let first = "";
      const dec = new TextDecoder();
      while (!first.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw Error("Stream ended before snapshot.");
        first += dec.decode(chunk.value, { stream: true });
      }
      const frame = first.split("\n\n")[0];
      if (!frame.startsWith("event: queue\n"))
        throw Error("Missing queue snapshot.");
      entry.snapshot = JSON.parse(frame.split("\ndata: ")[1]);
      if (!entry.snapshot.serverTime)
        throw Error("Missing snapshot timestamp.");
      open++;
      peak = Math.max(peak, open);
      entry.done = (async () => {
        try {
          while (!(await reader.read()).done) {
            /* Drain incremental frames until the connection closes. */
          }
          if (!controller.signal.aborted) connectionFailures++;
        } catch {
          if (!controller.signal.aborted) connectionFailures++;
        } finally {
          open--;
          streams.delete(entry);
          reader.releaseLock();
        }
      })();
      return entry;
    } catch (error) {
      connectionFailures++;
      controller.abort();
      streams.delete(entry);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    const { event, ids } = await seedFixture(
      models,
      config,
      runId,
      eventId,
      config.seed,
      clock,
    );
    const { queue, booking } = simulationRuntime(models, connection, clock);
    const app = createApp({
      clientOrigins: [],
      clock,
      features: { models, connection, env, queue, booking },
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = "http://127.0.0.1:" + server.address().port;
    for (const id of ids)
      tokens.set(
        String(id),
        "Bearer " +
          jwt.sign({}, env.jwtSecret, {
            algorithm: "HS256",
            issuer: "QueueTix",
            audience: "queuetix-api",
            subject: String(id),
            expiresIn: "1h",
          }),
      );
    const active = await pool(
      ids.slice(0, config.streams),
      Math.min(config.concurrency, 10),
      connect,
    );
    const path = "/events/" + eventId;
    const joined = await pool(ids, config.concurrency, async (id) => {
      const identity = await request(id, "/me");
      if (identity.user.id !== String(id))
        throw Error("Fixture identity mismatch.");
      const t = performance.now();
      const result = await request(id, path + "/queue/join", {}, true);
      joins.push(performance.now() - t);
      completedUsers++;
      return result ? id : null;
    });
    const participants = joined.filter(Boolean);
    await sleep(Math.max(0, +event.saleStartsAt - Date.now()));
    await queue.finishOpening(eventId);
    const ranking = await models.QueueEntry.find({ eventId })
      .sort("number")
      .lean();
    const expected = participants
      .map(String)
      .sort((a, b) =>
        digest(event.shuffleSeed + ":" + a).localeCompare(
          digest(event.shuffleSeed + ":" + b),
        ),
      );
    let orderingViolations = ranking.filter(
      (row, i) => row.number !== i + 1 || String(row.userId) !== expected[i],
    ).length;
    const memberIds = new Set(expected);
    const dropped =
      active.find((s) => memberIds.has(String(s.id))) ?? active[0];
    dropped.controller.abort();
    await dropped.done;
    const recovered = await connect(dropped.id);
    const expectedNumber =
      ranking.find((row) => String(row.userId) === String(dropped.id))
        ?.number ?? null;
    if ((recovered.snapshot.entry?.number ?? null) !== expectedNumber)
      throw Error("Reconnected queue number differs from storage.");
    reconnections++;
    for (const id of participants) await request(id, path + "/queue/ping", {});
    await queue.admit(eventId);
    let attempts = 0;
    const admitted = await models.QueueEntry.find({
      eventId,
      status: "admitted",
    })
      .sort("number")
      .lean();
    orderingViolations += admitted.filter(
      (row, i) => row.number !== i + 1,
    ).length;
    admissions.push({
      elapsedMs: Math.round(performance.now() - start),
      count: admitted.length,
    });
    for (const [i, row] of admitted.entries()) {
      const id = row.userId;
      if ((await request(id, path + "/queue/me")).entry.status !== "admitted")
        throw Error("Admission state mismatch.");
      for (let attempt = 0; attempt < 2; attempt++) {
        const offer = await request(
          id,
          path + "/best-available?tier=standard&count=2",
        );
        const seats = offer.seats.length ? offer.seats : offer.alternatives[0];
        if (!seats?.length) break;
        const t = performance.now();
        const { hold } = await request(id, path + "/holds", {
          seatIds: seats.map((s) => s.id),
          idempotencyKey: "http-hold-" + attempt,
        });
        holds.push(performance.now() - t);
        attempts++;
        const { order } = await request(id, "/orders", {
          eventId: String(eventId),
          holdId: hold.id,
          idempotencyKey: "http-order-" + attempt,
        });
        const fail = i === 0 && attempt === 0;
        const settled = await request(id, "/orders/" + order.id + "/mock", {
          outcome: fail ? "failed" : "succeeded",
        });
        if (settled.order.status !== (fail ? "failed" : "paid"))
          throw Error("HTTP settlement mismatch.");
        if (fail) {
          failedPayments++;
          continue;
        }
        break;
      }
    }
    await queue.checkSoldOut(eventId);
    const paid = await models.Order.find({ eventId, status: "paid" }).lean();
    const integrity = await booking.verifyEventIntegrity(eventId);
    const terminal = Object.fromEntries(
      (
        await models.QueueEntry.aggregate([
          { $match: { eventId } },
          { $group: { _id: "$status", n: { $sum: 1 } } },
        ])
      ).map((x) => [x._id, x.n]),
    );
    const soldSeats = await models.Seat.countDocuments({
        eventId,
        status: "sold",
      }),
      tickets = await models.Ticket.countDocuments({ eventId }),
      paidSeatCount = paid.reduce((n, o) => n + o.seatIds.length, 0);
    const failures = [];
    if (
      integrity.length ||
      soldSeats !== tickets ||
      tickets !== paidSeatCount ||
      !paid.length ||
      orderingViolations
    )
      failures.push("Booking integrity or ordering");
    if (
      completedUsers !== ids.length ||
      peak !== config.streams ||
      connectionFailures ||
      reconnections !== 1 ||
      participants.length + expected429 !== ids.length
    )
      failures.push("HTTP or SSE verification");
    return {
      users: ids.length,
      completedUsers,
      joined: participants.length,
      expected429,
      peakStreams: peak,
      reconnections,
      reconnectedQueueNumber: expectedNumber,
      connectionFailures,
      httpStatuses: codes,
      join: latency(joins),
      hold: latency(holds),
      buyers: paid.length,
      tickets,
      soldSeats,
      paidSeatCount,
      terminal,
      holdAttempts: attempts,
      failedPayments,
      expiredHolds: await models.Hold.countDocuments({
        eventId,
        status: "expired",
      }),
      abandonments: terminal.abandoned ?? 0,
      orderingViolations,
      peakActivePasses: admitted.length,
      admissions,
      integrity,
      unexpectedErrors,
      failures,
      wallMs: Math.round(performance.now() - start),
    };
  } finally {
    for (const s of streams) s.controller.abort();
    await Promise.allSettled([...streams].map((s) => s.done));
    if (server)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    await cleanFixture(models, runId, eventId);
  }
}
