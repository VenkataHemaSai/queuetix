import { createHash, randomBytes } from "node:crypto";
import { fail } from "../booking/rules.js";

export const queueIntegrity = (issue) =>
  Object.assign(
    fail(
      503,
      "QUEUE_INTEGRITY",
      "The waiting room is unavailable while event data is checked.",
    ),
    { issue },
  );

export function createOpening({
  Event,
  QueueEntry,
  clock,
  publish,
  inventory,
}) {
  async function finishOpening(eventId) {
    const now = clock.now();
    let event = await Event.findById(eventId).lean();
    if (!event || event.startsAt <= now) return;
    if (event.status === "lobby_open" && event.saleStartsAt <= now) {
      await inventory(event);
      event =
        (await Event.findOneAndUpdate(
          {
            _id: eventId,
            status: "lobby_open",
            saleStartsAt: { $lte: now },
            startsAt: { $gt: now },
          },
          [
            {
              $set: {
                status: "opening",
                openingStartedAt: now,
                shuffleSeed: {
                  $ifNull: ["$shuffleSeed", randomBytes(16).toString("hex")],
                },
                lobbyCount: { $ifNull: ["$lobbyJoinCount", 0] },
              },
            },
          ],
          { new: true },
        ).lean()) ?? (await Event.findById(eventId).lean());
      if (event?.status === "opening") publish(eventId, "queue");
    }
    if (event?.status !== "opening" || event.startsAt <= clock.now()) return;
    await inventory(event);
    if (
      !/^[0-9a-f]{32}$/i.test(event.shuffleSeed ?? "") ||
      !Number.isSafeInteger(event.lobbyCount)
    )
      throw queueIntegrity();

    const entries = await QueueEntry.find({ eventId })
      .select("_id userId number status joinedInLobby")
      .lean();
    if (
      entries.length !== event.lobbyCount ||
      entries.some((entry) => !entry.joinedInLobby)
    ) {
      if (await Event.exists({ _id: eventId, status: "opening" }))
        throw queueIntegrity();
      return;
    }
    const ranking = entries
      .map((entry) => ({
        ...entry,
        hash: createHash("sha256")
          .update(event.shuffleSeed + ":" + entry.userId)
          .digest("hex"),
      }))
      .sort(
        (a, b) =>
          a.hash.localeCompare(b.hash) ||
          String(a.userId).localeCompare(String(b.userId)),
      );

    const writes = [];
    for (const [index, entry] of ranking.entries()) {
      const number = index + 1;
      if (entry.status === "waiting" && entry.number === number) continue;
      if (entry.status !== "lobby" || entry.number != null)
        throw queueIntegrity();
      writes.push({
        updateOne: {
          filter: {
            _id: entry._id,
            eventId,
            joinedInLobby: true,
            status: "lobby",
            number: null,
          },
          update: { $set: { number, status: "waiting" } },
        },
      });
    }
    for (let index = 0; index < writes.length; index += 500) {
      if (event.startsAt <= clock.now()) return;
      await QueueEntry.bulkWrite(writes.slice(index, index + 500));
    }

    // A second opener may have finished while this invocation was numbering.
    if (!(await Event.exists({ _id: eventId, status: "opening" }))) return;
    const assigned = await QueueEntry.find({ eventId })
      .select("number status joinedInLobby")
      .sort("number")
      .lean();
    if (
      assigned.length !== ranking.length ||
      assigned.some(
        (entry, index) =>
          !entry.joinedInLobby ||
          entry.status !== "waiting" ||
          entry.number !== index + 1 ||
          String(entry._id) !== String(ranking[index]._id),
      )
    ) {
      if (await Event.exists({ _id: eventId, status: "opening" }))
        throw queueIntegrity();
      return;
    }
    const openedAt = clock.now();
    const result = await Event.updateOne(
      {
        _id: eventId,
        status: "opening",
        startsAt: { $gt: openedAt },
        lobbyCount: event.lobbyCount,
        shuffleSeed: event.shuffleSeed,
      },
      {
        $set: {
          status: "on_sale",
          nextNumber: event.lobbyCount + 1,
          admittedUpTo: 0,
          onSaleAt: openedAt,
        },
      },
    );
    if (result.modifiedCount) publish(eventId, "queue");
  }
  return { finishOpening };
}
