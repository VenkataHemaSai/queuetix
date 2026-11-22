import { jest } from "@jest/globals";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { connectMongo } from "../src/lib/db.js";
import { createFakeClock } from "../src/lib/clock.js";
import { initializeModels } from "../src/modules/models.js";
import { createDbStatus } from "../src/health/db-smoke.js";

const origin = "https://queuetix.example";
const clock = createFakeClock("2026-11-22T00:00:00Z");
const env = {
  jwtSecret: "test-only-secret-that-is-not-used-in-any-deployment",
  googleClientId: "configured",
  trustProxy: 0,
};
const eventInput = {
  title: "Cinema program",
  description: "An evening screening.",
  venue: "Screen One",
  type: "cinema",
  startsAt: "2026-12-03T14:30:00Z",
  saleStartsAt: "2026-12-01T14:30:00Z",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  tierPrices: { front: 20000, standard: 30000, premium: 40000 },
  isDemo: true,
};
let cluster, connection, models, app;

function verifyGoogle(token) {
  if (!["attendee", "organizer", "other", "admin", "staff"].includes(token))
    throw new Error("bad token");
  return {
    sub: token,
    email: `${token}@example.test`,
    email_verified: true,
    name: token,
  };
}

beforeAll(async () => {
  cluster = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  connection = await connectMongo(cluster.getUri("tickets_m1_test"), {
    monitorCommands: true,
  });
  models = await initializeModels(connection);
  app = createApp({
    clock,
    clientOrigins: [origin],
    features: { connection, models, env, verifyGoogle },
  });
});

afterAll(async () => {
  await connection?.close();
  await cluster?.stop();
});

async function login(identity, role = "attendee") {
  const first = await request(app)
    .post("/auth/google")
    .send({ credential: identity })
    .expect(200);
  if (role !== "attendee") {
    await models.User.updateOne({ _id: first.body.user.id }, { role });
    const next = await request(app)
      .post("/auth/google")
      .send({ credential: identity })
      .expect(200);
    return next.body;
  }
  return first.body;
}

const bearer = (session) => `Bearer ${session.token}`;

async function createDraft(session, input = eventInput) {
  const response = await request(app)
    .post("/organizer/events")
    .set("Authorization", bearer(session))
    .send(input)
    .expect(201);
  return response.body.event;
}

function publishDraft(session, event, revision = event.revision) {
  return request(app)
    .post(`/organizer/events/${event.id}/publish`)
    .set("Authorization", bearer(session))
    .send({ revision });
}

test("application readiness is independent of the database probe and makes no MongoDB calls", async () => {
  const dbResult = {
    ok: true,
    mongo: true,
    txn: true,
    latencyMs: 10,
    checkedAt: clock.now().toISOString(),
  };
  const dbStatus = createDbStatus();
  dbStatus.store(dbResult);
  const unavailable = createApp({
    clock,
    clientOrigins: [origin],
    dbStatus,
    features: { env },
  });
  const initialized = createApp({
    clock,
    clientOrigins: [origin],
    dbStatus,
    features: { connection, models, env },
  });
  const client = connection.getClient();
  const commands = [];
  const record = (event) => commands.push(event.commandName);
  client.on("commandStarted", record);
  try {
    await request(unavailable).get("/health").expect(200);
    await request(unavailable).get("/health/db").expect(200, dbResult);
    await request(unavailable).get("/events").expect(503);
    await request(unavailable)
      .get("/health/ready")
      .expect(503, { ok: false, code: "APP_NOT_READY" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(initialized)
        .get("/health/ready")
        .expect("Cache-Control", "no-store")
        .expect(200, { ok: true });
    }
    expect(commands).toEqual([]);
  } finally {
    client.off("commandStarted", record);
  }
});

test("T-AUTH-1 invalid Google credentials get 401 and callers cannot select their role", async () => {
  await request(app)
    .post("/auth/google")
    .send({ credential: "invalid" })
    .expect(401)
    .expect(({ body }) => expect(body.error.code).toBe("GOOGLE_TOKEN_INVALID"));
  await request(app)
    .post("/auth/google")
    .send({ credential: "attendee", role: "admin" })
    .expect(400);
  const session = await login("attendee");
  expect(session.user.role).toBe("attendee");
  await request(app)
    .get("/me")
    .set("Authorization", bearer(session))
    .expect(200, { user: session.user });
  expect((await login("attendee")).user.id).toBe(session.user.id);
  await request(app)
    .get("/me")
    .set("Authorization", `${bearer(session)}tampered`)
    .expect(401);
  clock.advance(3_600_000);
  await request(app)
    .get("/me")
    .set("Authorization", bearer(session))
    .expect(401)
    .expect(({ body }) => expect(body.error.code).toBe("SESSION_EXPIRED"));
});

test("demo creates an isolated attendee, reuses a valid guest session and enforces the rate limit", async () => {
  const demo = () => request(app).post("/auth/demo");
  const first = (await demo().expect(200)).body;
  const second = (await demo().expect(200)).body;
  expect(first.user).toMatchObject({ role: "attendee", isGuest: true });
  expect(first.user.email).toBeUndefined();
  expect(first.user.id).not.toBe(second.user.id);
  const resumed = (await demo().set("Authorization", bearer(first)).expect(200))
    .body;
  expect(resumed.user.id).toBe(first.user.id);
  await demo().expect(200);
  await demo().expect(200);
  await demo().expect(429).expect("Retry-After", /\d+/);
});

test("T-AUTH-2 organizer routes reject anonymous, attendee, admin and staff access", async () => {
  await request(app).post("/organizer/events").send(eventInput).expect(401);
  for (const role of ["attendee", "admin", "staff"]) {
    const session = await login(role, role);
    await request(app)
      .post("/organizer/events")
      .set("Authorization", bearer(session))
      .send(eventInput)
      .expect(403);
  }
  await request(app)
    .post("/admin/events/advance")
    .set("Authorization", bearer(await login("attendee")))
    .expect(404);
});

test("a signed role claim cannot preserve privileges after a MongoDB role change", async () => {
  const session = await login("other", "organizer");
  await models.User.updateOne({ _id: session.user.id }, { role: "attendee" });
  await request(app)
    .get("/me")
    .set("Authorization", bearer(session))
    .expect(200)
    .expect(({ body }) => expect(body.user.role).toBe("attendee"));
  await request(app)
    .post("/organizer/events")
    .set("Authorization", bearer(session))
    .send(eventInput)
    .expect(403);
});

test("T-LAYOUT-3 publishing concurrently creates one stable layout and public APIs omit inventory", async () => {
  const session = await login("organizer", "organizer");
  const other = await login("other", "organizer");
  const auth = bearer(session);
  const create = (body) =>
    request(app)
      .post("/organizer/events")
      .set("Authorization", auth)
      .send(body);
  const preflight = await request(app)
    .options("/organizer/events")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "authorization,content-type")
    .expect(204);
  expect(preflight.headers["access-control-allow-headers"]).toMatch(
    /Content-Type/i,
  );
  await create({ ...eventInput, saleStartsAt: eventInput.startsAt }).expect(
    400,
  );
  await create({ ...eventInput, tierPrices: { premium: 20000 } }).expect(400);
  await create({ ...eventInput, organizerId: other.user.id }).expect(400);
  const {
    body: { event },
  } = await create(eventInput).expect(201);
  expect(event).toMatchObject({ status: "draft", totalSeats: 0, isDemo: true });
  await request(app).get(`/events/${event.id}`).expect(404);
  await request(app)
    .get("/events")
    .expect(200)
    .expect(({ body }) => expect(body.events).toEqual([]));
  const path = `/organizer/events/${event.id}`;
  await request(app).get(path).set("Authorization", bearer(other)).expect(404);
  const revised = await request(app)
    .patch(path)
    .set("Authorization", auth)
    .send({
      ...eventInput,
      title: "Cinema program revised",
      revision: event.revision,
    })
    .expect(200);
  await request(app)
    .patch(path)
    .set("Authorization", auth)
    .send({ ...eventInput, revision: event.revision })
    .expect(409);
  const publish = () => publishDraft(session, revised.body.event);
  const responses = await Promise.all([publish(), publish()]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  expect(responses.map(({ body }) => body.event.revision)).toEqual([
    revised.body.event.revision + 1,
    revised.body.event.revision + 1,
  ]);
  const firstSeats = await models.Seat.find({ eventId: event.id })
    .sort("seatIndex")
    .lean();
  expect(firstSeats).toHaveLength(120);
  expect(firstSeats[0]).toMatchObject({
    label: "A1",
    status: "available",
    seatIndex: 0,
  });
  await publish().expect(200);
  expect(
    await models.Seat.find({ eventId: event.id }).sort("seatIndex").lean(),
  ).toEqual(firstSeats);
  const stored = await models.Event.findById(event.id).lean();
  expect(stored).toMatchObject({
    maxActive: 10,
    overAdmitBuffer: 2,
    maxSeatsPerUser: 4,
    holdSeconds: 300,
    passSeconds: 600,
    shuffleSeed: null,
    lobbyJoinCount: 0,
    lobbyCount: null,
    nextNumber: null,
    admittedUpTo: 0,
    isSimulation: false,
  });
  const detail = await request(app).get(`/events/${event.id}`).expect(200);
  expect(detail.body.event).toMatchObject({
    title: "Cinema program revised",
    status: "scheduled",
    totalSeats: 120,
  });
  expect(detail.body.event.layout.sections[0].id).toBe("main");
  expect(detail.body.event.seats).toBeUndefined();
  expect(detail.body.event.organizerId).toBeUndefined();
  await request(app).get(`/events/${event.id}/seats`).expect(404);
  await request(app)
    .get("/events?page=1&limit=1")
    .expect(200)
    .expect(({ body }) =>
      expect(body.events.map(({ id }) => id)).toEqual([event.id]),
    );
  await request(app).get("/events?limit=500").expect(400);
  await models.Event.updateOne({ _id: event.id }, { isSimulation: true });
  await request(app).get(`/events/${event.id}`).expect(404);
  await request(app)
    .get("/events")
    .expect(200)
    .expect(({ body }) => expect(body.events).toEqual([]));
});

test("publishing rejects an unreviewed revision and rejects stale requests after a newer publication", async () => {
  const session = await login("organizer", "organizer");
  const draft = await createDraft(session);
  const revised = await request(app)
    .patch(`/organizer/events/${draft.id}`)
    .set("Authorization", bearer(session))
    .send({ ...eventInput, revision: draft.revision, title: "Updated draft" })
    .expect(200);
  await request(app)
    .post(`/organizer/events/${draft.id}/publish`)
    .set("Authorization", bearer(session))
    .expect(400);
  await publishDraft(session, draft, "0").expect(400);
  await publishDraft(session, draft)
    .expect(409)
    .expect(({ body }) =>
      expect(body.error.code).toBe("PUBLICATION_REVISION_CHANGED"),
    );
  await request(app).get(`/events/${draft.id}`).expect(404);
  expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(0);
  const updated = revised.body.event;
  const published = await publishDraft(session, updated).expect(200);
  expect(published.body.event).toMatchObject({
    title: updated.title,
    status: "scheduled",
    revision: updated.revision + 1,
    totalSeats: 120,
  });
  await publishDraft(session, updated).expect(200, published.body);
  await publishDraft(session, draft).expect(409);
});

test("another organizer cannot edit or publish a draft even with the current revision", async () => {
  const session = await login("organizer", "organizer");
  const other = await login("other", "organizer");
  const draft = await createDraft(session);
  await request(app)
    .patch(`/organizer/events/${draft.id}`)
    .set("Authorization", bearer(other))
    .send({ ...eventInput, revision: draft.revision, title: "Unowned change" })
    .expect(404);
  await publishDraft(other, draft).expect(404);
  expect(await models.Event.findById(draft.id).lean()).toMatchObject({
    title: draft.title,
    revision: draft.revision,
    status: "draft",
    totalSeats: 0,
  });
  expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(0);
});

test("a seat insertion failure rolls back the event revision and any seats already inserted", async () => {
  const session = await login("organizer", "organizer");
  const draft = await createDraft(session);
  const insert = jest
    .spyOn(models.Seat, "insertMany")
    .mockImplementationOnce(async ([first], { session }) => {
      await models.Seat.create([first], { session });
      throw new Error("Injected seat insertion failure");
    });
  try {
    await publishDraft(session, draft)
      .expect(500)
      .expect(({ body }) => expect(body.error.code).toBe("INTERNAL_ERROR"));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(await models.Event.findById(draft.id).lean()).toMatchObject({
      revision: draft.revision,
      status: "draft",
      totalSeats: 0,
    });
    expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(0);
    await request(app).get(`/events/${draft.id}`).expect(404);
  } finally {
    insert.mockRestore();
  }
  await publishDraft(session, draft).expect(200);
  expect(await models.Seat.countDocuments({ eventId: draft.id })).toBe(120);
});

test("fractional INR amounts persist as integer paise in events and seats and remain paise in the public API", async () => {
  const session = await login("organizer", "organizer");
  const tierPrices = { standard: 19999 };
  const draft = await createDraft(session, {
    ...eventInput,
    type: "bus",
    tierPrices,
  });
  await publishDraft(session, draft).expect(200);
  const stored = await models.Event.findById(draft.id).lean();
  expect(stored.layout.tierPrices).toEqual(tierPrices);
  const seats = await models.Seat.find({ eventId: draft.id }).lean();
  expect(seats).toHaveLength(40);
  expect(seats.every((seat) => seat.price === 19999)).toBe(true);
  await request(app)
    .get(`/events/${draft.id}`)
    .expect(200)
    .expect(({ body }) =>
      expect(body.event).toMatchObject({
        currency: "INR",
        tierPrices,
        layout: { tierPrices },
      }),
    );
});
