import { missingEvent, sameId } from "./rules.js";

export const seatInventoryIssue =
  "Seat counts do not match the event inventory.";

function groupBy(records, key) {
  const groups = new Map();
  for (const record of records) {
    const text = String(record[key]);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(record);
  }
  return groups;
}

export function createIntegrity({
  Event,
  Seat,
  Hold,
  Order,
  Ticket,
  Quota,
  Pass,
  queueEntries,
  transaction,
}) {
  return function verifyEventIntegrity(eventId, { preSweep = false } = {}) {
    return transaction(async ({ session, now }) => {
      const event = await Event.findById(eventId).session(session).lean();
      if (!event) throw missingEvent();
      const seats = await Seat.find({ eventId }).session(session).lean();
      const holds = await Hold.find({ eventId, status: "active" })
        .session(session)
        .lean();
      const orders = await Order.find({ eventId, status: "paid" })
        .session(session)
        .lean();
      const tickets = await Ticket.find({ eventId }).session(session).lean();
      const quotas = await Quota.find({ eventId }).session(session).lean();
      const errors = [];
      const seatById = new Map(seats.map((seat) => [String(seat._id), seat]));
      const holdById = new Map(holds.map((hold) => [String(hold._id), hold]));
      const ticketsBySeat = groupBy(tickets, "seatId");
      const ordersBySeat = new Map();

      if (
        seats.length !== event.totalSeats ||
        seats.some(
          ({ status }) => !["available", "held", "sold"].includes(status),
        )
      ) {
        errors.push(seatInventoryIssue);
      }
      for (const order of orders) {
        for (const seatId of order.seatIds.map(String)) {
          if (!ordersBySeat.has(seatId)) ordersBySeat.set(seatId, []);
          ordersBySeat.get(seatId).push(order);
          const seat = seatById.get(seatId);
          if (seat?.status !== "sold" || !sameId(seat.orderId, order._id)) {
            errors.push(
              `Paid order ${order._id} does not own sold seat ${seatId}.`,
            );
          }
        }
        if (
          order.amount !==
          order.seatIds.reduce(
            (sum, seatId) => sum + (seatById.get(String(seatId))?.price ?? 0),
            0,
          )
        ) {
          errors.push(`Paid order ${order._id} has an inconsistent amount.`);
        }
      }
      for (const seat of seats) {
        const seatId = String(seat._id);
        const paid = ordersBySeat.get(seatId) ?? [];
        const issued = ticketsBySeat.get(seatId) ?? [];
        if (paid.length > 1)
          errors.push(`Seat ${seat.label} appears in multiple paid orders.`);
        if (seat.status === "sold") {
          if (
            paid.length !== 1 ||
            issued.length !== 1 ||
            !sameId(seat.orderId, paid[0]._id) ||
            !sameId(issued[0].orderId, paid[0]._id) ||
            !sameId(issued[0].userId, paid[0].userId)
          ) {
            errors.push(
              `Sold seat ${seat.label} lacks a matching paid order and ticket.`,
            );
          }
        } else if (issued.length) {
          errors.push(`Unsold seat ${seat.label} has a ticket.`);
        }
        if (seat.status === "held") {
          const hold = holdById.get(String(seat.holdId));
          if (
            !hold ||
            !hold.seatIds.some((id) => sameId(id, seat._id)) ||
            seat.holdExpiresAt?.getTime() !== hold.expiresAt.getTime()
          ) {
            errors.push(
              `Held seat ${seat.label} has inconsistent hold ownership.`,
            );
          }
        }
      }
      for (const { seatId } of tickets) {
        if (!seatById.has(String(seatId)))
          errors.push(`Ticket refers to missing event seat ${seatId}.`);
      }
      for (const hold of holds) {
        const expired = hold.expiresAt <= now;
        if (expired && !preSweep)
          errors.push(`Expired hold ${hold._id} is still active.`);
        for (const seatId of hold.seatIds) {
          const seat = seatById.get(String(seatId));
          if (
            !seat ||
            ((!expired || !preSweep) &&
              (seat.status !== "held" || !sameId(seat.holdId, hold._id)))
          ) {
            errors.push(
              `Active hold ${hold._id} has inconsistent seat ${seatId}.`,
            );
          }
        }
      }
      const heldByUser = groupBy(holds, "userId"),
        paidByUser = groupBy(orders, "userId");
      const quotaByUser = groupBy(quotas, "userId");
      const users = new Set([
        ...heldByUser.keys(),
        ...paidByUser.keys(),
        ...quotaByUser.keys(),
      ]);
      for (const user of users) {
        const userHolds = heldByUser.get(user) ?? [];
        const userOrders = paidByUser.get(user) ?? [];
        const userQuotas = quotaByUser.get(user) ?? [];
        const held = userHolds.reduce(
          (total, hold) => total + hold.seatIds.length,
          0,
        );
        const bought = userOrders.reduce(
          (total, order) => total + order.seatIds.length,
          0,
        );
        if (
          userQuotas.length !== 1 ||
          userQuotas[0].held !== held ||
          userQuotas[0].bought !== bought ||
          userOrders.length > 1 ||
          userHolds.length > 1 ||
          held + bought > event.maxSeatsPerUser
        ) {
          errors.push(`User ${user} has inconsistent booking quota.`);
        }
      }
      if (queueEntries) {
        const entries = await queueEntries
          .find({ eventId })
          .session(session)
          .lean();
        const activePasses = await Pass.find({
          eventId,
          status: "active",
          expiresAt: { $gt: now },
        })
          .session(session)
          .lean();
        const passById = new Map(
          activePasses.map((pass) => [String(pass._id), pass]),
        );
        const numbers = new Set();
        for (const entry of entries) {
          const user = String(entry.userId);
          const paid = paidByUser.has(user);
          if (entry.number != null) {
            if (
              !Number.isSafeInteger(entry.number) ||
              entry.number < 1 ||
              (event.nextNumber != null && entry.number >= event.nextNumber) ||
              numbers.has(entry.number)
            )
              errors.push("Queue contains an invalid or duplicate number.");
            numbers.add(entry.number);
          }
          if (
            entry.status === "waiting" &&
            !(entry.number > event.admittedUpTo)
          )
            errors.push(
              "Waiting entry is at or behind the admission watermark.",
            );
          if (entry.rejoinCount < 0 || entry.rejoinCount > 1)
            errors.push("Queue entry has an invalid rejoin count.");
          if (entry.status === "completed" && !paid)
            errors.push("Completed queue entry lacks a paid order.");
          if (paid && entry.status !== "completed")
            errors.push("Paid user still has an incomplete queue entry.");
          if (
            entry.status === "admitted" &&
            !preSweep &&
            !sameId(passById.get(String(entry.passId))?.userId, entry.userId) &&
            !(
              event.status === "sold_out" &&
              (heldByUser.get(user) ?? []).some((hold) => hold.expiresAt > now)
            )
          )
            errors.push("Admitted queue entry lacks its active pass.");
        }
        if (event.status === "sold_out" && activePasses.length)
          errors.push("Sold-out event still has active passes.");
      }
      return errors;
    });
  };
}
