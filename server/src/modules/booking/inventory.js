import { fail, missingEvent, requireSale, sameId } from "./rules.js";

const available = (seat, now) =>
  seat.status === "available" ||
  (seat.status === "held" && seat.holdExpiresAt && seat.holdExpiresAt <= now);

function publicSeat(seat, hold, now) {
  return {
    id: String(seat._id),
    seatIndex: seat.seatIndex,
    label: seat.label,
    tier: seat.tier,
    price: seat.price,
    status: available(seat, now) ? "available" : seat.status,
    mine: Boolean(
      hold &&
      seat.status === "held" &&
      seat.holdExpiresAt > now &&
      sameId(hold._id, seat.holdId),
    ),
  };
}

function rankedBlocks(seats, dimensions, count) {
  const byRow = new Map();
  for (const seat of seats) {
    const key = `${seat.section}:${seat.row}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(seat);
  }
  const blocks = [];
  for (const row of byRow.values()) {
    row.sort((a, b) => a.col - b.col);
    const { centerRow, centerCol } = dimensions.get(row[0].section);
    for (let i = 0; i + count <= row.length; i += 1) {
      const first = row[i],
        last = row[i + count - 1];
      if (last.col - first.col !== count - 1) continue;
      const distance =
        Math.abs(first.row - centerRow) +
        Math.abs((first.col + last.col) / 2 - centerCol);
      blocks.push({
        seats: row.slice(i, i + count),
        distance,
        index: first.seatIndex,
      });
    }
  }
  return blocks.sort((a, b) => a.distance - b.distance || a.index - b.index);
}

export function createInventory({
  Event,
  Seat,
  Hold,
  Order,
  Payment,
  Ticket,
  activePass,
  clock,
}) {
  const currentHold = (eventId, userId, now) =>
    Hold.findOne({
      eventId,
      userId,
      status: "active",
      expiresAt: { $gt: now },
    }).lean();

  async function listSeats(eventId, userId) {
    const now = clock.now();
    await activePass(eventId, userId, { now });
    const [hold, seats] = await Promise.all([
      currentHold(eventId, userId, now),
      Seat.find({ eventId }).sort("seatIndex").lean(),
    ]);
    return seats.map((seat) => publicSeat(seat, hold, now));
  }

  async function bestAvailable(eventId, userId, tier, count) {
    const now = clock.now();
    await activePass(eventId, userId, { now });
    const event = await Event.findById(eventId).lean();
    requireSale(event, now);
    if (
      !Object.hasOwn(event.layout.tierPrices, tier) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > event.maxSeatsPerUser
    ) {
      throw fail(
        400,
        "INVALID_SUGGESTION",
        "Choose a configured tier and a valid group size.",
      );
    }
    const seats = await Seat.find({ eventId, tier }).lean();
    const candidates = seats.filter((seat) => available(seat, now));
    const dimensions = new Map(
      event.layout.sections.map(({ id, rows, seatsPerRow, aisleAfter }) => [
        id,
        {
          centerRow: (rows.length - 1) / 2,
          centerCol: (seatsPerRow + aisleAfter.length - 1) / 2,
        },
      ]),
    );
    const map = (block) =>
      block.seats.map((seat) => publicSeat(seat, null, now));
    const [exact] = rankedBlocks(candidates, dimensions, count);
    if (exact) return { seats: map(exact), alternatives: [] };
    for (let size = count - 1; size > 0; size -= 1) {
      const smaller = rankedBlocks(candidates, dimensions, size);
      if (smaller.length)
        return { seats: [], alternatives: smaller.slice(0, 3).map(map) };
    }
    return { seats: [], alternatives: [] };
  }

  async function bookingState(eventId, userId) {
    const now = clock.now();
    const event = await Event.findOne({
      _id: eventId,
      status: { $ne: "draft" },
    })
      .select("maxSeatsPerUser")
      .lean();
    if (!event) throw missingEvent();
    const [pass, hold, latestOrder] = await Promise.all([
      activePass(eventId, userId, { now }).catch((error) => {
        if (error.code === "PASS_REQUIRED") return null;
        throw error;
      }),
      currentHold(eventId, userId, now),
      Order.findOne({ eventId, userId })
        .sort({ createdAt: -1, _id: -1 })
        .lean(),
    ]);
    const order =
      hold && latestOrder && !sameId(latestOrder.holdId, hold._id)
        ? await Order.findOne({ holdId: hold._id, userId }).lean()
        : latestOrder;
    const seats = hold
      ? await Seat.find({ eventId, holdId: hold._id, status: "held" })
          .sort("seatIndex")
          .lean()
      : [];
    return {
      pass,
      hold: hold && {
        ...hold,
        seats: seats.map((seat) => publicSeat(seat, hold, now)),
      },
      order,
      maxSeatsPerUser: event.maxSeatsPerUser,
      serverTime: now.toISOString(),
    };
  }

  const lastPayment = (orderId) =>
    Payment.findOne({ orderId }).sort({ processedAt: -1, _id: -1 }).lean();

  async function myTickets(userId, page, limit) {
    const result = await Ticket.find({ userId })
      .sort({ issuedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .lean();
    const tickets = result.slice(0, limit);
    const [events, orders] = await Promise.all([
      Event.find({ _id: { $in: tickets.map(({ eventId }) => eventId) } })
        .select("title venue startsAt timeZone")
        .lean(),
      Order.find({
        _id: { $in: tickets.map(({ orderId }) => orderId) },
        userId,
        status: "paid",
      }).lean(),
    ]);
    const eventById = new Map(
      events.map((event) => [String(event._id), event]),
    );
    const orderById = new Map(
      orders.map((order) => [String(order._id), order]),
    );
    return {
      page,
      hasNext: result.length > limit,
      tickets: tickets.flatMap((ticket) => {
        const event = eventById.get(String(ticket.eventId)),
          order = orderById.get(String(ticket.orderId));
        if (!event || !order) return [];
        const line = order.seatLines.find(({ seatId }) =>
          sameId(seatId, ticket.seatId),
        );
        if (!line) return [];
        return [
          {
            id: String(ticket._id),
            status: ticket.status,
            qrPayload: ticket.qrPayload,
            event: {
              id: String(ticket.eventId),
              title: event.title,
              venue: event.venue,
              startsAt: event.startsAt,
              timeZone: event.timeZone,
            },
            order: {
              id: String(order._id),
              amount: order.amount,
              currency: order.currency,
            },
            seat: line,
          },
        ];
      }),
    };
  }

  return { listSeats, bestAvailable, bookingState, lastPayment, myTickets };
}
