import { fail, missingEvent } from "../booking/rules.js";
import { seatInventoryIssue } from "../booking/integrity.js";
import { holdView, orderView } from "../booking/routes.js";
import { queueIntegrity } from "./opening.js";

const closed = () =>
  fail(409, "SALE_CLOSED", "New sale participation is closed.");
const isOpen = (event, now) =>
  event.status === "on_sale" &&
  event.startsAt > now &&
  event.saleStartsAt <= now;
const scope = (eventId, userId) => ({ eventId, userId });
const active = { status: "active" };

export function createQueueService({
  Event,
  QueueEntry,
  Pass,
  Seat,
  Order,
  booking,
  clock,
  transaction,
  presence,
  publish,
  simulation = false,
}) {
  const admissionTimes = new Map();
  const joining = new Map();
  const findEvent = async (id, session = null) => {
    const event = await Event.findOne({
      _id: id,
      status: { $ne: "draft" },
      isSimulation: simulation,
    })
      .session(session)
      .lean();
    if (!event) throw missingEvent();
    return event;
  };

  async function inventory(event, session = null, now = clock.now()) {
    const [counts] = await Seat.aggregate([
      { $match: { eventId: event._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          available: {
            $sum: { $cond: [{ $eq: ["$status", "available"] }, 1, 0] },
          },
          held: { $sum: { $cond: [{ $eq: ["$status", "held"] }, 1, 0] } },
          reclaimable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "held"] },
                    { $eq: [{ $type: "$holdExpiresAt" }, "date"] },
                    { $lte: ["$holdExpiresAt", now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          sold: { $sum: { $cond: [{ $eq: ["$status", "sold"] }, 1, 0] } },
        },
      },
    ]).session(session);
    if (
      !counts?.total ||
      counts.total !== event.totalSeats ||
      counts.available + counts.held + counts.sold !== counts.total
    )
      throw queueIntegrity(seatInventoryIssue);
    return counts;
  }

  function join(eventId, userId) {
    const key = String(eventId);
    // The single process queues competing joins before they contend on the event document.
    const prior = joining.get(key) ?? Promise.resolve();
    const attempt = prior
      .catch(() => {})
      .then(() => joinTransaction(eventId, userId));
    joining.set(key, attempt);
    return attempt.finally(() => {
      if (joining.get(key) === attempt) joining.delete(key);
    });
  }

  async function joinTransaction(eventId, userId) {
    return transaction(async ({ session, now, afterCommit }) => {
      const event = await findEvent(eventId, session);
      if (event.startsAt <= now || ["sold_out", "ended"].includes(event.status))
        throw closed();
      if (event.status === "scheduled")
        throw fail(
          409,
          "LOBBY_NOT_OPEN",
          "The waiting room has not opened yet.",
        );
      if (event.status === "opening")
        throw fail(
          503,
          "SALE_OPENING",
          "The sale is opening. Try again shortly.",
          { retryAfterMs: 1500 },
        );
      const owner = scope(eventId, userId);
      const prior = await QueueEntry.findOne(owner).session(session).lean();
      if (prior) return prior;
      if (await Order.exists({ ...owner, status: "paid" }).session(session))
        throw fail(
          409,
          "ALREADY_BOOKED",
          "You already have a paid booking for this event.",
        );
      const inLobby = event.status === "lobby_open";
      if (
        !inLobby &&
        (!isOpen(event, now) || !Number.isSafeInteger(event.nextNumber))
      )
        throw closed();
      const before = await Event.findOneAndUpdate(
        { _id: eventId, status: event.status, startsAt: { $gt: now } },
        { $inc: { [inLobby ? "lobbyJoinCount" : "nextNumber"]: 1 } },
        { session },
      ).lean();
      if (!before) throw closed();
      const [created] = await QueueEntry.create(
        [
          {
            ...owner,
            status: inLobby ? "lobby" : "waiting",
            number: inLobby ? null : before.nextNumber,
            joinedInLobby: inLobby,
            joinedAt: now,
          },
        ],
        { session },
      );
      afterCommit(() => {
        presence.touch(eventId, userId, now);
        publish(eventId, "queue", { userId });
      });
      return created.toObject();
    });
  }

  function rejoinReason(event, entry, stock, now, paid) {
    if (paid || entry?.status === "completed") return "ALREADY_BOOKED";
    if (entry?.rejoinCount) return "REJOIN_LIMIT";
    if (!isOpen(event, now)) return "SALE_CLOSED";
    if (
      !entry ||
      !(
        entry.status === "expired" ||
        (entry.status === "abandoned" && entry.number <= event.admittedUpTo)
      )
    )
      return "REJOIN_NOT_ELIGIBLE";
    if (stock <= 0) return "NO_STOCK";
    return null;
  }

  function rejoin(eventId, userId, key) {
    return transaction(async ({ session, now, afterCommit }) => {
      const event = await findEvent(eventId, session);
      const owner = scope(eventId, userId);
      const entry = await QueueEntry.findOne(owner).session(session).lean();
      if (entry?.rejoinKey === key && key) return entry;
      const paid = await Order.exists({ ...owner, status: "paid" }).session(
        session,
      );
      const beforeInventory = rejoinReason(event, entry, Infinity, now, paid);
      if (beforeInventory)
        throw fail(409, beforeInventory, "This queue entry cannot rejoin.");
      const counts = await inventory(event, session, now);
      if (counts.available + counts.reclaimable === 0)
        throw fail(
          409,
          "NO_STOCK",
          "No seats are currently available for rejoining.",
        );
      if (!Number.isSafeInteger(event.nextNumber)) throw queueIntegrity();
      const previous = await Event.findOneAndUpdate(
        {
          _id: eventId,
          status: "on_sale",
          startsAt: { $gt: now },
          admittedUpTo: event.admittedUpTo,
        },
        { $inc: { nextNumber: 1 } },
        { session },
      ).lean();
      if (!previous) throw closed();
      const updated = await QueueEntry.findOneAndUpdate(
        { _id: entry._id, status: entry.status, rejoinCount: 0 },
        {
          $set: {
            status: "waiting",
            number: previous.nextNumber,
            rejoinKey: key,
          },
          $inc: { rejoinCount: 1 },
          $unset: { passId: 1 },
        },
        { new: true, session },
      ).lean();
      if (!updated) throw queueIntegrity();
      afterCommit(() => {
        presence.touch(eventId, userId, now);
        publish(eventId, "queue", { userId });
      });
      return updated;
    });
  }

  function restore(eventId, userId) {
    return transaction(async ({ session, now, afterCommit }) => {
      const event = await findEvent(eventId, session);
      if (!isOpen(event, now)) return;
      const entry = await QueueEntry.findOne({
        ...scope(eventId, userId),
        status: "abandoned",
        number: { $gt: event.admittedUpTo },
      })
        .session(session)
        .lean();
      if (!entry) return;
      // Writing the event serializes restoration with a controller advancing the watermark.
      const guard = await Event.updateOne(
        {
          _id: eventId,
          status: "on_sale",
          admittedUpTo: { $lt: entry.number },
          startsAt: { $gt: now },
        },
        { $inc: { queueRevision: 1 } },
        { session },
      );
      if (!guard.matchedCount) return;
      const updated = await QueueEntry.updateOne(
        { _id: entry._id, number: entry.number, status: "abandoned" },
        { $set: { status: "waiting" } },
        { session },
      );
      if (updated.modifiedCount)
        afterCommit(() => publish(eventId, "queue", { userId }));
    });
  }

  const ping = (eventId, userId) =>
    presence.touch(eventId, userId, clock.now());

  function recordAdmissions(eventId, now, count) {
    const key = String(eventId);
    const recent = (admissionTimes.get(key) ?? []).filter(
      (time) => +now - time < 120_000,
    );
    admissionTimes.set(key, recent.concat(Array(count).fill(+now)));
  }

  function admit(eventId) {
    return transaction(async (txn) => {
      const { now, session, afterCommit } = txn;
      const event = await findEvent(eventId, session);
      if (!isOpen(event, now) || !Number.isSafeInteger(event.nextNumber))
        return;
      const entries = await QueueEntry.find({
        eventId,
        number: { $gt: event.admittedUpTo },
      })
        .sort("number")
        .limit(64)
        .session(session)
        .lean();
      if (!entries.length) return;
      const passes = await Pass.countDocuments({
        eventId,
        ...active,
        expiresAt: { $gt: now },
      }).session(session);
      const counts = await inventory(event, session, now);
      const stock = counts.available + counts.reclaimable;
      if (counts.sold === counts.total) return;
      const slots = Math.max(
        0,
        Math.min(
          event.maxActive - passes,
          stock + event.overAdmitBuffer - passes,
        ),
      );
      if (!slots) return;
      const updates = [];
      let admitted = 0;
      let through = event.admittedUpTo;
      for (const entry of entries) {
        if (admitted >= slots) break;
        if (entry.status !== "waiting") {
          through = entry.number;
          continue;
        }
        const connection = presence.status(eventId, entry.userId, now);
        if (connection === "protected") break;
        const filter = {
          _id: entry._id,
          status: "waiting",
          number: entry.number,
        };
        if (connection === "timed_out") {
          const changed = await QueueEntry.updateOne(
            filter,
            { $set: { status: "abandoned" } },
            { session },
          );
          if (!changed.modifiedCount) throw queueIntegrity();
          updates.push({ userId: entry.userId, type: "queue" });
        } else {
          const pass = await booking.issuePass(eventId, entry.userId, txn);
          const changed = await QueueEntry.updateOne(
            filter,
            { $set: { status: "admitted", passId: pass._id } },
            { session },
          );
          if (!changed.modifiedCount) throw queueIntegrity();
          admitted += 1;
          updates.push({ userId: entry.userId, type: "admitted" });
        }
        through = entry.number;
      }
      if (through === event.admittedUpTo) return;
      const updated = await Event.updateOne(
        {
          _id: eventId,
          status: "on_sale",
          admittedUpTo: event.admittedUpTo,
          startsAt: { $gt: now },
        },
        { $max: { admittedUpTo: through } },
        { session },
      );
      if (!updated.modifiedCount) throw queueIntegrity();
      afterCommit(() => {
        recordAdmissions(eventId, now, admitted);
        publish(eventId, "queue", { updates });
      });
    });
  }

  async function metrics(eventId) {
    const now = clock.now();
    const event = await findEvent(eventId);
    const counts = await inventory(event, null, now).catch((error) => {
      if (error.code !== "QUEUE_INTEGRITY") throw error;
      return null;
    });
    const recent = (admissionTimes.get(String(eventId)) ?? []).filter(
      (time) => +now - time < 120_000,
    );
    return {
      eventStatus: event.status,
      lobbyOpensAt: event.lobbyOpensAt,
      saleStartsAt: event.saleStartsAt,
      startsAt: event.startsAt,
      serverTime: now.toISOString(),
      saleClosed:
        now >= event.startsAt || ["sold_out", "ended"].includes(event.status),
      admittedUpTo: event.admittedUpTo,
      seatsRemaining: counts?.available ?? null,
      hasActiveHolds: counts ? counts.held > counts.reclaimable : false,
      stock: counts ? counts.available + counts.reclaimable : 0,
      admissions: recent.length,
    };
  }

  function view(eventId, userId, individual, shared) {
    const { entry, pass, hold, order } = individual;
    const { admittedUpTo, admissions, stock, ...metrics } = shared;
    const now = new Date(shared.serverTime);
    const approximatePosition =
      entry?.status === "waiting" &&
      shared.eventStatus === "on_sale" &&
      !shared.saleClosed
        ? Math.max(1, entry.number - admittedUpTo)
        : null;
    const reason = rejoinReason(
      {
        status: shared.eventStatus,
        startsAt: new Date(shared.startsAt),
        saleStartsAt: new Date(shared.saleStartsAt),
        admittedUpTo,
      },
      entry,
      stock,
      now,
      order?.status === "paid",
    );
    return {
      ...metrics,
      entry,
      pass,
      hold,
      order,
      approximatePosition,
      etaMinutes:
        approximatePosition !== null && admissions >= 3
          ? Math.ceil((approximatePosition * 2) / admissions)
          : null,
      canRejoin: reason === null,
      rejoinReason: reason,
      rejoinCount: entry?.rejoinCount ?? 0,
      connection:
        presence.status(eventId, userId, now) === "connected"
          ? "connected"
          : "reconnecting",
    };
  }

  async function individual(eventId, userId, refresh = false) {
    const owner = scope(eventId, userId);
    let entry = await QueueEntry.findOne(owner).lean();
    if (refresh && entry?.status === "abandoned") {
      await restore(eventId, userId);
      entry = await QueueEntry.findOne(owner).lean();
    }
    const data = await booking.bookingState(eventId, userId);
    const order =
      entry?.status === "completed" && data.order?.status !== "paid"
        ? await Order.findOne({ ...owner, status: "paid" }).lean()
        : data.order;
    return {
      entry: entry && {
        status: entry.status,
        number: entry.number,
        rejoinCount: entry.rejoinCount,
      },
      pass: data.pass && { expiresAt: data.pass.expiresAt },
      hold: holdView(data.hold),
      order: orderView(order),
    };
  }

  async function me(eventId, userId) {
    await findEvent(eventId);
    ping(eventId, userId);
    const data = await individual(eventId, userId, true);
    return view(eventId, userId, data, await metrics(eventId));
  }

  return {
    join,
    rejoin,
    admit,
    ping,
    restore,
    me,
    individual,
    metrics,
    view,
    inventory,
    findEvent,
    resetRates: () => admissionTimes.clear(),
  };
}
