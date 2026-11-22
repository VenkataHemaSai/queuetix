import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createFakeClock } from "../src/lib/clock.js";
import { createDbStatus } from "../src/health/db-smoke.js";
import { readEnv } from "../src/config/env.js";

const origin = "https://queuetix.example";
const clock = createFakeClock("2026-11-21T12:00:00.000Z");
const app = createApp({
  clock,
  clientOrigins: [origin],
  dbStatus: createDbStatus(),
});

test("health is lightweight and uses the injected clock", async () => {
  const first = await request(app).get("/health").expect(200);
  expect(first.body).toEqual({
    ok: true,
    service: "QueueTix",
    version: expect.any(String),
    time: "2026-11-21T12:00:00.000Z",
  });
  expect(first.headers["x-content-type-options"]).toBe("nosniff");
  clock.advance(1250);
  const next = await request(app).get("/health").expect(200);
  expect(next.body.time).toBe("2026-11-21T12:00:01.250Z");
  expect(await request(app).get("/health/db").expect(503)).toMatchObject({
    body: { ok: false, mongo: null, txn: null, checkedAt: null },
  });
});

test("fake clock returns an independent timestamp and can advance without a wall-clock wait", () => {
  const fake = createFakeClock(0);
  fake.now().setTime(12);
  expect(fake.now().getTime()).toBe(0);
  fake.advance(30_000);
  expect(fake.now().getTime()).toBe(30_000);
});

test("T-CORS-1 only known origins pass Authorization preflight and the actual GET", async () => {
  const preflight = (from) =>
    request(app)
      .options("/health/cors")
      .set("Origin", from)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");
  const allowed = await preflight(origin).expect(204);
  expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
  expect(allowed.headers["access-control-allow-headers"]).toMatch(
    /authorization/i,
  );
  expect(allowed.headers.vary).toMatch(/Origin/i);
  const unknown = "https://unknown.example";
  const denied = await preflight(unknown).expect(403);
  expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  expect(denied.body.error.code).toBe("CORS_ORIGIN_DENIED");
  await request(app)
    .get("/health/cors")
    .set("Origin", unknown)
    .set("Authorization", "smoke")
    .expect(403);
  await request(app)
    .get("/health/cors")
    .set("Origin", origin)
    .expect(400)
    .expect({
      error: {
        code: "AUTHORIZATION_HEADER_REQUIRED",
        message: "Send an Authorization header for this check.",
      },
    });
  await request(app)
    .get("/health/cors")
    .set("Origin", origin)
    .set("Authorization", "smoke")
    .expect("Access-Control-Allow-Origin", origin)
    .expect(200, { ok: true });
});

test("validates M0 environment without echoing secrets", () => {
  const env = {
    MONGODB_URI: "mongodb://127.0.0.1:27017/tickets_dev",
    JWT_SECRET: "test-only-secret-at-least-thirty-two-characters",
    PAYMENT_WEBHOOK_SECRET:
      "test-only-payment-secret-at-least-thirty-two-characters",
    QR_HMAC_SECRET: "test-only-ticket-secret-at-least-thirty-two-characters",
    CLIENT_ORIGIN: "http://localhost:5173, https://queuetix.example",
  };
  expect(readEnv(env)).toMatchObject({
    port: 3000,
    clientOrigins: ["http://localhost:5173", origin],
  });
  expect(() =>
    readEnv({ ...env, CLIENT_ORIGIN: "*", MONGODB_URI: "secret-value" }),
  ).toThrow("Invalid environment variables: CLIENT_ORIGIN, MONGODB_URI");
  expect(() =>
    readEnv({ ...env, CLIENT_ORIGIN: "https://queuetix.example/path" }),
  ).toThrow("CLIENT_ORIGIN");
});

test("unhandled paths use stable JSON and the startup probe has no public write route", async () => {
  await request(app)
    .post("/internal/health/db-smoke")
    .expect(404)
    .expect({ error: { code: "NOT_FOUND", message: "Endpoint not found." } });
});

test("SSE flushes ten incremental ticks at the production cadence, then sends done and closes", async () => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const arrivals = [];
  let buffer = "";
  let ended = false;
  let response;
  const stream = get(`http://127.0.0.1:${server.address().port}/health/sse`);
  try {
    [response] = await once(stream, "response", {
      signal: AbortSignal.timeout(4000),
    });
    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      buffer += chunk;
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const match = /^event: (\w+)\ndata: (.+)$/.exec(frame);
        if (match)
          arrivals.push({
            type: match[1],
            payload: JSON.parse(match[2]),
            at: performance.now(),
          });
      }
    });
    const finished = once(response, "end", {
      signal: AbortSignal.timeout(28000),
    }).then(() => {
      ended = true;
    });
    await sleep(3300);
    expect(ended).toBe(false);
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.length).toBeLessThan(10);
    await finished;
    expect(arrivals.map(({ type }) => type)).toEqual([
      ...Array(10).fill("tick"),
      "done",
    ]);
    const ticks = arrivals.slice(0, 10);
    ticks.forEach(({ payload, at }, index) => {
      expect(payload.tick).toBe(index + 1);
      expect(Number.isFinite(Date.parse(payload.time))).toBe(true);
      if (index > 0) {
        expect(at - ticks[index - 1].at).toBeGreaterThan(1400);
        expect(at - ticks[index - 1].at).toBeLessThan(4000);
      }
    });
  } finally {
    stream.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
