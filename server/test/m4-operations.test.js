import { fixture, newId, testDatabase } from "./m4-fixture.js";
import { signTicketPayload } from "../src/modules/booking/signatures.js";

let db;
beforeAll(async () => {
  db = await testDatabase("tickets_m4_ops");
});
afterAll(async () => {
  await db?.close();
});

test("T-RATE-1: forwarded headers cannot bypass the five-join limit and a rejected join cannot allocate a number", async () => {
  const f = await fixture(db);
  const users = await Promise.all(Array.from({ length: 6 }, () => f.user()));
  const join = (index) =>
    f.api
      .post("/events/" + f.event._id + "/queue/join")
      .set("Authorization", f.auth(users[index]))
      .set("X-Forwarded-For", "198.51.100." + (index + 1));
  for (let index = 0; index < 5; index++)
    expect((await join(index)).status).toBe(200);
  const rejected = await join(5);
  expect(rejected.status).toBe(429);
  expect(rejected.headers["retry-after"]).toBe("60");
  expect(rejected.body.error.code).toBe("RATE_LIMITED");
  expect(
    await f.models.QueueEntry.countDocuments({ eventId: f.event._id }),
  ).toBe(5);
  f.clock.advance(60_000);
  expect((await join(5)).body.entry.number).toBe(6);
});

test("T-RATE-1: twenty hold requests share a user window and rejected requests make no changes", async () => {
  const f = await fixture(db);
  const a = await f.user();
  const b = await f.user();
  await Promise.all(
    [a, b].map(({ _id }) => f.booking.issuePass(f.event._id, _id)),
  );
  const hold = (user, seat, idempotencyKey) =>
    f.api
      .post("/events/" + f.event._id + "/holds")
      .set("Authorization", f.auth(user))
      .send({ seatIds: [seat._id], idempotencyKey });
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => hold(a, f.seats[0], "stable")),
  );
  expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(200));
  expect(new Set(responses.map(({ body }) => body.hold.id)).size).toBe(1);
  const rejected = await hold(a, f.seats[2], "new");
  expect([rejected.status, rejected.headers["retry-after"]]).toEqual([
    429,
    "60",
  ]);
  expect((await f.models.Seat.findById(f.seats[2]._id)).status).toBe(
    "available",
  );
  expect((await hold(b, f.seats[1], "independent")).status).toBe(200);
  f.clock.advance(60_000);
  expect((await hold(a, f.seats[0], "stable")).status).toBe(200);
});

test("T-RATE-1: configured proxy depth separates verified client IPs and ignores spoofed extra hops", async () => {
  const f = await fixture(db, { env: { trustProxy: 1 } });
  const a = await f.user();
  const b = await f.user();
  const join = (user, forwarded) =>
    f.api
      .post("/events/" + f.event._id + "/queue/join")
      .set("Authorization", f.auth(user))
      .set("X-Forwarded-For", forwarded);
  for (let index = 1; index <= 5; index++) {
    const result = await join(a, "198.51.100." + index + ", 203.0.113.10");
    expect(result.body.entry.number).toBe(1);
  }
  expect((await join(a, "198.51.100.6, 203.0.113.10")).status).toBe(429);
  expect((await join(b, "198.51.100.6, 203.0.113.11")).body.entry.number).toBe(
    2,
  );
});

test("T-SCAN-1: only assigned staff can redeem once, and scan details persist without exposing the code", async () => {
  const f = await fixture(db);
  const [buyer, staff, otherStaff, admin] = await Promise.all([
    f.user(),
    f.user("staff"),
    f.user("staff"),
    f.user("admin"),
  ]);
  const { order } = await f.begin(buyer._id);
  await f.booking.confirmPayment({
    orderId: order._id,
    outcome: "succeeded",
    providerRef: "old-m2:" + order._id,
  });
  const ticket = await f.models.Ticket.findOne({ orderId: order._id }).lean();
  const validate = (user, payload = ticket.qrPayload) =>
    f.api
      .post("/tickets/validate")
      .set("Authorization", f.auth(user))
      .send({ eventId: f.event._id, payload });
  const assign = (user) =>
    f.api
      .put("/operations/events/" + f.event._id + "/staff/" + staff._id)
      .set("Authorization", f.auth(user));
  expect((await validate(buyer)).status).toBe(403);
  expect((await validate(staff)).status).toBe(403);
  expect((await assign(f.owner)).status).toBe(403);
  expect((await assign(admin)).status).toBe(204);
  expect((await validate(otherStaff)).status).toBe(403);
  const tampered = ticket.qrPayload.replace(/.$/, (last) =>
    last === "a" ? "b" : "a",
  );
  expect((await validate(staff, tampered)).status).toBe(422);
  const unknown = signTicketPayload(
    newId(),
    "fixture-m4-ticket-signature-local-only",
  );
  expect((await validate(staff, unknown)).status).toBe(422);
  await f.models.Ticket.updateOne(
    { _id: ticket._id },
    { $set: { status: "void" } },
  );
  expect((await validate(staff)).status).toBe(422);
  await f.models.Ticket.updateOne(
    { _id: ticket._id },
    { $set: { status: "valid" } },
  );
  const results = await Promise.all([validate(staff), validate(staff)]);
  expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
  expect(results.find(({ status }) => status === 409).body.error.code).toBe(
    "ALREADY_USED",
  );
  expect(
    JSON.stringify(results.find(({ status }) => status === 200).body),
  ).not.toContain(ticket.qrPayload);
  expect((await f.models.Ticket.findById(ticket._id)).scannedBy).toEqual(
    staff._id,
  );
  const history = await f.api
    .get("/staff/events/" + f.event._id + "/scans")
    .set("Authorization", f.auth(staff));
  expect(history.body.scans).toEqual([
    expect.objectContaining({
      status: "used",
      scannedAt: f.clock.now().toISOString(),
    }),
  ]);
  const revoke = await f.api
    .delete("/operations/events/" + f.event._id + "/staff/" + staff._id)
    .set("Authorization", f.auth(admin));
  expect(revoke.status).toBe(204);
  expect((await validate(staff)).status).toBe(403);
});

test("dashboard scopes organizers, distinguishes expired stock and reports incomplete inventory", async () => {
  const f = await fixture(db, { event: { passSeconds: 60 } });
  const other = await fixture(db, { noSeats: true });
  const buyer = await f.user();
  await f.begin(buyer._id);
  f.clock.advance(300_001);
  const report = (event, user) =>
    f.api
      .get("/operations/events/" + event._id)
      .set("Authorization", f.auth(user));
  expect((await report(f.event, other.owner)).status).toBe(404);
  expect((await report(f.event, buyer)).status).toBe(403);
  const admin = await f.user("admin");
  const result = await report(f.event, admin);
  expect(result.body.metrics).toMatchObject({
    activeAdmissions: 0,
    activeHolds: 0,
    availableSeats: 3,
    reclaimableSeats: 1,
    soldSeats: 0,
  });
  expect(result.body.admissions.at(-6).count).toBe(1);
  const check = () =>
    other.api
      .post("/operations/events/" + other.event._id + "/integrity")
      .set("Authorization", other.auth(other.owner));
  expect((await check()).body).toMatchObject({
    status: "FAIL",
    checkedAt: expect.any(String),
    issueCount: 1,
  });
  expect((await check()).status).toBe(429);
  expect(
    (await report(other.event, admin)).body.metrics.availableSeats,
  ).toBeNull();
});
