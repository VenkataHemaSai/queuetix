import { buildLayout, layoutSeats } from "../../../../shared/seat-layout.js";
import { HttpError } from "../../lib/http.js";
import { withTxn } from "../../lib/db.js";
import { publishedStatuses } from "./event.model.js";

const publicEvents = {
  status: { $in: publishedStatuses },
  isSimulation: false,
};
const notFound = () =>
  new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
const publicationChanged = () =>
  new HttpError(
    409,
    "PUBLICATION_REVISION_CHANGED",
    "This draft changed. Review the updated event before publishing.",
  );

function summary(event) {
  const {
    title,
    description,
    venue,
    type,
    status,
    currency,
    timeZone,
    startsAt,
    saleStartsAt,
    lobbyOpensAt,
    totalSeats,
    isDemo,
  } = event;
  return {
    id: String(event._id),
    title,
    description,
    venue,
    type,
    status,
    currency,
    timeZone,
    startsAt,
    saleStartsAt,
    lobbyOpensAt,
    totalSeats,
    isDemo,
    tierPrices: event.layout.tierPrices,
  };
}

function detail(event) {
  return { ...summary(event), layout: event.layout };
}

function organizerDetail(event) {
  const {
    revision,
    maxActive,
    overAdmitBuffer,
    maxSeatsPerUser,
    holdSeconds,
    passSeconds,
  } = event;
  return {
    ...detail(event),
    revision,
    maxActive,
    overAdmitBuffer,
    maxSeatsPerUser,
    holdSeconds,
    passSeconds,
  };
}

function eventData({ tierPrices, ...input }) {
  return {
    ...input,
    layout: buildLayout(input.type, tierPrices),
    lobbyOpensAt: new Date(Date.parse(input.saleStartsAt) - 10 * 60_000),
  };
}

export function createEventService({ Event, Seat, connection, clock }) {
  const moment = () => clock.now().toISOString();
  const own = (organizerId) => ({ organizerId, isSimulation: false });

  async function list(filter, sort, { page, limit }) {
    const events = await Event.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .lean();
    return {
      events: events.slice(0, limit).map(summary),
      page,
      hasNext: events.length > limit,
    };
  }

  return {
    listPublic: (pagination) =>
      list(publicEvents, { startsAt: 1, _id: 1 }, pagination),
    listOwned: (owner, pagination) =>
      list(own(owner), { updatedAt: -1, _id: -1 }, pagination),

    async getPublic(id) {
      const event = await Event.findOne({ _id: id, ...publicEvents }).lean();
      if (!event) throw notFound();
      return { event: detail(event), serverTime: moment() };
    },

    async getOwned(id, owner) {
      const event = await Event.findOne({ _id: id, ...own(owner) }).lean();
      if (!event) throw notFound();
      return organizerDetail(event);
    },

    async create(input, organizerId) {
      return organizerDetail(
        await Event.create({ ...eventData(input), organizerId }),
      );
    },

    async edit(id, owner, { revision, ...input }) {
      const filter = { _id: id, ...own(owner) };
      const updated = await Event.findOneAndUpdate(
        { ...filter, status: "draft", revision },
        { $set: eventData(input), $inc: { revision: 1 } },
        { new: true, runValidators: true },
      ).lean();
      if (updated) return organizerDetail(updated);
      if (!(await Event.exists(filter))) throw notFound();
      throw new HttpError(
        409,
        "EVENT_CHANGED",
        "This draft changed. Reload the current version before editing again.",
      );
    },

    publish(id, owner, revision) {
      return withTxn(
        async ({ session, now }) => {
          const filter = { _id: id, ...own(owner) };
          const event = await Event.findOne(filter).session(session).lean();
          if (!event) throw notFound();
          if (event.status !== "draft") {
            // Publication increments the revision once, then the draft is immutable.
            if (event.revision - 1 === revision) return organizerDetail(event);
            throw publicationChanged();
          }
          if (event.revision !== revision) throw publicationChanged();
          if (event.saleStartsAt <= now) {
            throw new HttpError(
              409,
              "SALE_START_PAST",
              "Choose a future sale start before publishing.",
            );
          }
          const seats = layoutSeats(event.layout);
          const published = await Event.findOneAndUpdate(
            { ...filter, status: "draft", revision },
            {
              $set: { status: "scheduled", totalSeats: seats.length },
              $inc: { revision: 1 },
            },
            { new: true, session, runValidators: true },
          ).lean();
          if (!published) throw publicationChanged();
          await Seat.insertMany(
            seats.map((seat) => ({ ...seat, eventId: id })),
            { session },
          );
          return organizerDetail(published);
        },
        { connection, clock },
      );
    },
  };
}
