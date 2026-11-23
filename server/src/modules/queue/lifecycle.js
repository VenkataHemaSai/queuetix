import { queueIntegrity } from "./opening.js";
import { seatInventoryIssue } from "../booking/integrity.js";

const saleStates = [
  "scheduled",
  "lobby_open",
  "opening",
  "on_sale",
  "sold_out",
];
const active = { status: "active" };
const eventFields =
  "status startsAt totalSeats nextNumber admittedUpTo soldOutCleanedAt";
const maintenanceErrors = new Set([
  "MongoOperationTimeoutError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "DB_DEADLINE_EXCEEDED",
  "TXN_RETRIES_EXHAUSTED",
  "TXN_COMMIT_UNCONFIRMED",
]);

export function createQueueLifecycle({
  Event,
  QueueEntry,
  Hold,
  Order,
  Pass,
  clock,
  transaction,
  booking,
  queue,
  opening,
  presence,
  publish,
  report,
}) {
  const reported = new Set();
  const cutoffNotices = new Set();
  const invalidInventory = new Set();
  function note(eventId, message) {
    const key = String(eventId) + ":" + message;
    if (reported.has(key)) return;
    reported.add(key);
    report({ eventId: String(eventId), issue: message });
  }

  async function checked(eventId, phase, action, reportFailure) {
    const key = String(eventId);
    if (invalidInventory.has(key)) return null;
    const started = performance.now();
    try {
      return await action();
    } catch (error) {
      if (error.code === "QUEUE_INTEGRITY") {
        if (error.issue === seatInventoryIssue) invalidInventory.add(key);
        note(eventId, error.issue ?? "Queue failed its integrity check.");
        return null;
      }
      if (
        reportFailure &&
        (maintenanceErrors.has(error.name) || maintenanceErrors.has(error.code))
      ) {
        reportFailure(error, {
          phase,
          eventId: key,
          elapsedMs: Math.round(performance.now() - started),
        });
        return null;
      }
      throw error;
    }
  }

  async function close(eventId) {
    return transaction(async ({ session, now, afterCommit }) => {
      const event = await Event.findOne({
        _id: eventId,
        status: { $in: saleStates },
        startsAt: { $lte: now },
      })
        .session(session)
        .lean();
      if (!event) return;
      // Keeping unswept active rows as blockers also serializes closure with M2 order creation.
      const held = await Hold.exists({ eventId, ...active }).session(session);
      const pending = await Order.exists({
        eventId,
        status: "pending",
      }).session(session);
      if (held || pending) {
        if (["scheduled", "lobby_open", "opening"].includes(event.status))
          afterCommit(() =>
            note(
              eventId,
              "Pre-sale event reached its cutoff with outstanding settlement.",
            ),
          );
        else if (pending)
          afterCommit(() =>
            note(eventId, "Event start passed with unresolved settlement."),
          );
        return;
      }
      await queue.inventory(event, session, now);
      const changed = await Event.updateOne(
        { _id: eventId, status: event.status, startsAt: { $lte: now } },
        { $set: { status: "ended" } },
        { session },
      );
      if (changed.modifiedCount) afterCommit(() => publish(eventId, "queue"));
    });
  }

  async function checkSchedule(reportFailure) {
    const now = clock.now();
    const due = Event.find({
      isSimulation: false,
      $or: [
        { status: { $in: saleStates }, startsAt: { $lte: now } },
        { status: "scheduled", lobbyOpensAt: { $lte: now } },
        { status: "lobby_open", saleStartsAt: { $lte: now } },
        { status: "opening" },
        { status: "on_sale", nextNumber: null },
      ],
    })
      .select(eventFields)
      .lean()
      .cursor();
    for await (const event of due)
      await checked(
        event._id,
        "event schedule",
        async () => {
          const eventId = event._id;
          if (event.startsAt <= clock.now()) {
            const key = String(eventId);
            if (!cutoffNotices.has(key)) {
              cutoffNotices.add(key);
              publish(eventId, "queue");
            }
            if (["on_sale", "sold_out"].includes(event.status))
              await checkSoldOut(eventId, event);
            await close(eventId);
            return;
          }
          if (event.status === "on_sale") {
            await queue.inventory(event);
            if (await QueueEntry.exists({ eventId })) throw queueIntegrity();
            await Event.updateOne(
              {
                _id: eventId,
                status: "on_sale",
                nextNumber: null,
                startsAt: { $gt: clock.now() },
              },
              { $set: { nextNumber: 1, admittedUpTo: 0 } },
            );
            return;
          }
          if (event.status === "scheduled") {
            await queue.inventory(event);
            const changed = await Event.updateOne(
              {
                _id: eventId,
                status: "scheduled",
                lobbyOpensAt: { $lte: now },
                startsAt: { $gt: clock.now() },
              },
              { $set: { status: "lobby_open" } },
            );
            if (changed.modifiedCount) publish(eventId, "queue");
          }
          await opening.finishOpening(eventId);
        },
        reportFailure,
      );
  }

  async function expireEntries() {
    const now = clock.now();
    // Drive the reconciliation from current admissions, so expired history does not grow the sweep.
    const candidates = QueueEntry.find({
      status: "admitted",
      passId: { $type: "objectId" },
    })
      .select("_id eventId userId passId")
      .lean()
      .cursor();
    for await (const entry of candidates) {
      const expired = {
        _id: entry.passId,
        status: "expired",
        expiresAt: { $lte: now },
      };
      if (!(await Pass.exists(expired))) continue;
      await transaction(async ({ session, afterCommit }) => {
        if (!(await Pass.exists(expired).session(session))) return;
        if (
          await Order.exists({
            eventId: entry.eventId,
            userId: entry.userId,
            status: "paid",
          }).session(session)
        )
          return;
        const changed = await QueueEntry.updateOne(
          { _id: entry._id, status: "admitted", passId: entry.passId },
          { $set: { status: "expired" } },
          { session },
        );
        if (changed.modifiedCount)
          afterCommit(() =>
            publish(entry.eventId, "pass:expired", { userId: entry.userId }),
          );
      });
    }
  }

  async function cleanSoldOut(eventId) {
    const now = clock.now();
    const liveHolds = await Hold.distinct("userId", {
      eventId,
      ...active,
      expiresAt: { $gt: now },
    });
    const eligible = {
      eventId,
      $or: [
        { status: "waiting" },
        { status: "admitted", userId: { $nin: liveHolds } },
      ],
    };
    for (;;) {
      const batch = await QueueEntry.find(eligible)
        .select("_id")
        .limit(500)
        .lean();
      if (!batch.length) break;
      await QueueEntry.updateMany(
        { ...eligible, _id: { $in: batch.map((entry) => entry._id) } },
        { $set: { status: "expired_soldout" } },
      );
    }
    await Pass.updateMany(
      { eventId, ...active },
      { $set: { status: "expired" } },
    );
    if (!liveHolds.length)
      await Event.updateOne(
        { _id: eventId, status: "sold_out", soldOutCleanedAt: null },
        { $set: { soldOutCleanedAt: now } },
      );
    else note(eventId, "A sold-out event has an outstanding hold.");
    publish(eventId, "sold_out");
  }

  async function checkSoldOut(eventId, snapshot) {
    const event =
      snapshot ?? (await Event.findById(eventId).select(eventFields).lean());
    if (!event || !["on_sale", "sold_out"].includes(event.status)) return false;
    if (event.status === "sold_out" && event.soldOutCleanedAt) return false;
    if (event.status === "on_sale") {
      const counts = await queue.inventory(event);
      if (counts.sold !== counts.total) return false;
    }
    // Confirm the final sale inside the transition transaction.
    const sold = await transaction(async ({ session, now }) => {
      const event = await Event.findOne({
        _id: eventId,
        status: { $in: ["on_sale", "sold_out"] },
      })
        .session(session)
        .lean();
      if (!event) return false;
      if (event.status === "sold_out") return !event.soldOutCleanedAt;
      const counts = await queue.inventory(event, session, now);
      if (counts.sold !== counts.total) return false;
      const changed = await Event.updateOne(
        { _id: eventId, status: "on_sale" },
        { $set: { status: "sold_out" } },
        { session },
      );
      return Boolean(changed.modifiedCount);
    });
    if (sold) await cleanSoldOut(eventId);
    return sold;
  }

  async function sales(admit, reportFailure) {
    const now = clock.now();
    const events = Event.find({
      isSimulation: false,
      $or: [
        { status: "on_sale", startsAt: { $gt: now } },
        { status: "sold_out", soldOutCleanedAt: null },
      ],
    })
      .select(eventFields)
      .lean()
      .cursor();
    for await (const event of events) {
      const sold = await checked(
        event._id,
        "sold-out check",
        () => checkSoldOut(event._id, event),
        reportFailure,
      );
      if (
        !admit ||
        sold !== false ||
        event.status !== "on_sale" ||
        event.startsAt <= clock.now()
      )
        continue;
      await checked(
        event._id,
        "admission",
        async () => {
          // Terminal entries ahead of the watermark still need to be examined.
          if (
            await QueueEntry.exists({
              eventId: event._id,
              number: { $gt: event.admittedUpTo },
            })
          )
            await queue.admit(event._id);
        },
        reportFailure,
      );
    }
  }

  async function sweep() {
    await booking.sweepExpired();
    await expireEntries();
    await expireDisconnected();
  }

  async function expireDisconnected() {
    for (const [eventId, users] of presence.timedOut(clock.now())) {
      for (let index = 0; index < users.length; index += 64) {
        const candidates = await QueueEntry.find({
          eventId,
          status: "waiting",
          userId: { $in: users.slice(index, index + 64) },
        })
          .select("_id userId number")
          .lean();
        if (!candidates.length) continue;
        await transaction(async ({ session, now, afterCommit }) => {
          const event = await Event.findOne({
            _id: eventId,
            status: "on_sale",
            startsAt: { $gt: now },
          })
            .select("admittedUpTo")
            .session(session)
            .lean();
          if (!event) return;
          const stale = candidates.filter(
            (entry) =>
              entry.number > event.admittedUpTo &&
              presence.status(eventId, entry.userId, now) === "timed_out",
          );
          if (!stale.length) return;
          const guard = await Event.updateOne(
            {
              _id: eventId,
              status: "on_sale",
              admittedUpTo: event.admittedUpTo,
            },
            { $inc: { queueRevision: 1 } },
            { session },
          );
          if (!guard.matchedCount) return;
          const changed = await QueueEntry.updateMany(
            {
              _id: { $in: stale.map((entry) => entry._id) },
              status: "waiting",
              number: { $gt: event.admittedUpTo },
            },
            { $set: { status: "abandoned" } },
            { session },
          );
          if (changed.modifiedCount)
            afterCommit(() =>
              publish(eventId, "queue", {
                updates: stale.map(({ userId }) => ({ userId, type: "queue" })),
              }),
            );
        });
      }
    }
  }

  async function recover() {
    invalidInventory.clear();
    presence.reset();
    queue.resetRates();
    await checkSchedule();
    await sweep();
    await sales(false);
    await checkSchedule();
    const now = clock.now();
    for await (const row of QueueEntry.find({ status: "waiting" })
      .select("eventId userId")
      .lean()
      .cursor())
      presence.protect(row.eventId, row.userId, now);
    for await (const event of Event.find({
      status: { $ne: "draft" },
      isSimulation: false,
    })
      .select("_id")
      .lean()
      .cursor()) {
      const errors = await booking.verifyEventIntegrity(event._id);
      for (const issue of errors) {
        if (issue === seatInventoryIssue)
          invalidInventory.add(String(event._id));
        note(event._id, issue);
      }
    }
  }

  async function tick(reportFailure) {
    presence.prune(clock.now());
    await checkSchedule(reportFailure);
    await sales(true, reportFailure);
  }

  return { checkSchedule, checkSoldOut, sweep, recover, tick, expireEntries };
}
