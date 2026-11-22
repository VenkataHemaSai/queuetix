import { alreadyBooked, expires, passRequired, requireSale } from "./rules.js";

export function createAdmission({ Event, Pass, Quota, clock, transaction }) {
  const passFilter = (eventId, userId, now) => ({
    eventId,
    userId,
    status: "active",
    expiresAt: { $gt: now },
  });

  async function activePass(
    eventId,
    userId,
    { session, now = clock.now() } = {},
  ) {
    const pass = await Pass.findOne(passFilter(eventId, userId, now))
      .session(session ?? null)
      .lean();
    if (!pass) throw passRequired();
    return pass;
  }

  async function issue(eventId, userId, { session, now }) {
    const event = await Event.findById(eventId).session(session).lean();
    requireSale(event, now);
    const owner = { eventId, userId };
    const quota = await Quota.findOneAndUpdate(
      owner,
      { $setOnInsert: { held: 0, bought: 0 }, $inc: { revision: 1 } },
      { session, upsert: true, new: true, setDefaultsOnInsert: false },
    ).lean();
    if (quota.bought) throw alreadyBooked();
    const current = await Pass.findOne({ ...owner, status: "active" })
      .session(session)
      .lean();
    if (current?.expiresAt > now) return current;
    if (current)
      await Pass.updateOne(
        { _id: current._id, status: "active", expiresAt: { $lte: now } },
        { $set: { status: "expired" } },
        { session },
      );
    const [pass] = await Pass.create(
      [{ ...owner, issuedAt: now, expiresAt: expires(now, event.passSeconds) }],
      { session },
    );
    return pass.toObject();
  }

  async function issuePass(eventId, userId, context) {
    if (context) return issue(eventId, userId, context);
    const work = (txn) => issue(eventId, userId, txn);
    try {
      return await transaction(work);
    } catch (error) {
      if (error.code !== 11000) throw error;
      return transaction(work);
    }
  }

  return { activePass, issuePass };
}
