import {
  expires,
  fail,
  newId,
  objectId,
  requireSale,
  sameId,
  sameRequest,
} from "./rules.js";
import { fingerprint } from "./signatures.js";

const invalidSeats = () =>
  fail(
    400,
    "INVALID_SEAT_SELECTION",
    "Select unique seats from this event within the seat limit.",
  );
const holdExists = () =>
  fail(409, "HOLD_EXISTS", "You already have a hold for this event.");
const noHold = () =>
  fail(
    409,
    "HOLD_EXPIRED",
    "This hold has expired or changed. Refresh your selection.",
  );
const unavailableSeats = (seats) =>
  fail(409, "SEAT_UNAVAILABLE", "Some of the selected seats are unavailable.", {
    labels: seats.map(({ label }) => label),
  });
const active = { status: "active" };
const idOf = (value) => String(value).toLowerCase();
const unavailable = (seat, now) =>
  seat.status !== "available" &&
  !(seat.status === "held" && seat.holdExpiresAt <= now);

function selection(seatIds) {
  if (
    !Array.isArray(seatIds) ||
    !seatIds.length ||
    seatIds.length > 4 ||
    !seatIds.every(objectId)
  )
    throw invalidSeats();
  const ids = seatIds.map(idOf).sort();
  if (new Set(ids).size !== ids.length) throw invalidSeats();
  return ids;
}

export function createHolds({
  Event,
  Seat,
  Hold,
  Quota,
  Pass,
  AuditLog,
  clock,
  transaction,
  activePass,
  publish,
}) {
  const keyFilter = (userId, idempotencyKey) => ({ userId, idempotencyKey });

  async function retireHold(holdId, status, { session, now, afterCommit }) {
    const filter = {
      _id: holdId,
      ...active,
      ...(status === "expired" && { expiresAt: { $lte: now } }),
    };
    const hold = await Hold.findOneAndUpdate(
      filter,
      { $set: { status } },
      { session },
    ).lean();
    if (!hold) return null;
    const { eventId, userId } = hold;
    const owned = { eventId, holdId, status: "held" };
    const seatIds =
      publish &&
      (await Seat.find(owned).select("_id").session(session).lean()).map(
        ({ _id }) => _id,
      );
    await Seat.updateMany(
      owned,
      { $set: { status: "available", holdId: null, holdExpiresAt: null } },
      { session },
    );
    const change = await Quota.updateOne(
      { eventId, userId, held: { $gte: hold.seatIds.length } },
      { $inc: { held: -hold.seatIds.length } },
      { session },
    );
    if (!change.matchedCount) throw new Error("Hold quota is inconsistent.");
    await AuditLog.create(
      [{ eventId, userId, holdId, action: `hold.${status}`, at: now }],
      { session },
    );
    if (publish)
      afterCommit(() => publish(eventId, "seat:released", { userId, seatIds }));
    return { ...hold, status };
  }

  async function eventAndSeats(eventId, ids, { session }) {
    const event = await Event.findById(eventId).session(session).lean();
    if (!event || event.status === "draft")
      throw fail(404, "EVENT_NOT_FOUND", "Event not found.");
    if (ids.length > event.maxSeatsPerUser) throw invalidSeats();
    const seats = await Seat.find({ eventId, _id: { $in: ids } })
      .session(session)
      .lean();
    if (seats.length !== ids.length) throw invalidSeats();
    return { event, seats };
  }

  async function claim(
    { event, userId, ids, passId, expiresAt, key, signature },
    { session, now, afterCommit },
  ) {
    const owner = { eventId: event._id, userId };
    const holdId = newId();
    const seatFilter = { eventId: event._id, _id: { $in: ids } };
    const quota = await Quota.updateOne(
      {
        ...owner,
        bought: 0,
        $expr: {
          $lte: [
            { $add: ["$held", "$bought", ids.length] },
            event.maxSeatsPerUser,
          ],
        },
      },
      { $inc: { held: ids.length } },
      { session },
    );
    if (!quota.matchedCount)
      throw fail(
        409,
        "QUOTA_EXCEEDED",
        "This selection exceeds your booking limit.",
      );
    const claimed = await Seat.updateMany(
      {
        ...seatFilter,
        $or: [
          { status: "available" },
          { status: "held", holdExpiresAt: { $lte: now } },
        ],
      },
      { $set: { status: "held", holdId, holdExpiresAt: expiresAt } },
      { session },
    );
    if (claimed.modifiedCount !== ids.length) {
      const rejected = await Seat.find({
        ...seatFilter,
        holdId: { $ne: holdId },
      })
        .select("label")
        .session(session)
        .lean();
      throw unavailableSeats(rejected);
    }
    const [hold] = await Hold.create(
      [
        {
          _id: holdId,
          ...owner,
          passId,
          seatIds: ids,
          expiresAt,
          ...(key && { idempotencyKey: key, requestFingerprint: signature }),
        },
      ],
      { session },
    );
    await AuditLog.create(
      [{ ...owner, holdId, action: "hold.created", at: now }],
      { session },
    );
    if (publish)
      afterCommit(() =>
        publish(event._id, "seat:held", { userId, seatIds: ids }),
      );
    return hold.toObject();
  }

  async function expireOwnStaleHold(owner, txn) {
    const hold = await Hold.findOne({ ...owner, ...active })
      .session(txn.session)
      .lean();
    if (!hold || hold.expiresAt > txn.now) return hold;
    await retireHold(hold._id, "expired", txn);
    return null;
  }

  async function createHold(eventId, userId, seatIds, key) {
    const ids = selection(seatIds);
    const owner = { eventId, userId };
    const keyScope = keyFilter(userId, key);
    const signature = fingerprint([idOf(eventId), ids]);
    try {
      return await transaction(async (txn) => {
        const previous = await Hold.findOne(keyScope)
          .session(txn.session)
          .lean();
        if (previous) return sameRequest(previous, signature);
        const { event, seats } = await eventAndSeats(eventId, ids, txn);
        requireSale(event, txn.now);
        const current = await expireOwnStaleHold(owner, txn);
        const pass = await activePass(eventId, userId, txn);
        if (current) throw holdExists();
        const blocked = seats.filter((seat) => unavailable(seat, txn.now));
        if (blocked.length) throw unavailableSeats(blocked);
        return claim(
          {
            event,
            userId,
            ids,
            passId: pass._id,
            expiresAt: expires(txn.now, event.holdSeconds),
            key,
            signature,
          },
          txn,
        );
      });
    } catch (error) {
      if (
        ![11000, "TXN_RETRIES_EXHAUSTED", "DB_DEADLINE_EXCEEDED"].includes(
          error.code,
        )
      )
        throw error;
      const previous = await Hold.findOne(keyScope).lean();
      if (previous) return sameRequest(previous, signature);
      const now = clock.now();
      if (await Hold.exists({ ...owner, ...active, expiresAt: { $gt: now } }))
        throw holdExists();
      if (error.code !== 11000) {
        await activePass(eventId, userId, { now });
        const seats = await Seat.find({ eventId, _id: { $in: ids } }).lean();
        const blocked = seats.filter((seat) => unavailable(seat, now));
        if (blocked.length) throw unavailableSeats(blocked);
      }
      throw error;
    }
  }

  async function replaceHold(eventId, userId, holdId, seatIds) {
    const ids = selection(seatIds);
    const result = await transaction(async (txn) => {
      const { event } = await eventAndSeats(eventId, ids, txn);
      requireSale(event, txn.now);
      const old = await expireOwnStaleHold({ eventId, userId }, txn);
      const pass = await activePass(eventId, userId, txn);
      if (!old || !sameId(old._id, holdId)) return null;
      await retireHold(old._id, "released", txn);
      return claim(
        { event, userId, ids, passId: pass._id, expiresAt: old.expiresAt },
        txn,
      );
    });
    if (!result) throw noHold();
    return result;
  }

  function releaseHold(eventId, userId, holdId) {
    return transaction(async (txn) => {
      const hold = await Hold.findOne({ _id: holdId, eventId, userId })
        .session(txn.session)
        .lean();
      if (!hold) throw fail(404, "HOLD_NOT_FOUND", "Hold not found.");
      if (hold.status !== "active") return hold;
      return retireHold(
        hold._id,
        hold.expiresAt <= txn.now ? "expired" : "released",
        txn,
      );
    });
  }

  async function sweepExpired(eventId) {
    const now = clock.now();
    const scope = eventId ? { eventId } : {};
    const overdue = Hold.find({ ...scope, ...active, expiresAt: { $lte: now } })
      .select("_id")
      .lean()
      .cursor();
    for await (const hold of overdue)
      await transaction((txn) => retireHold(hold._id, "expired", txn));
    await Pass.updateMany(
      { ...scope, ...active, expiresAt: { $lte: now } },
      { $set: { status: "expired" } },
    );
  }

  return { createHold, replaceHold, releaseHold, retireHold, sweepExpired };
}
