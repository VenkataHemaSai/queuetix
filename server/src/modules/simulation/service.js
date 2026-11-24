import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import {
  digest,
  latency,
  pool,
  seedFixture,
  simulationRuntime,
} from "./fixture.js";
import { assertSimulationStore } from "./scope.js";
export async function cleanFixture(models, runId, eventId) {
  assertSimulationStore(models);
  if (!runId || !(eventId instanceof Types.ObjectId))
    throw Error("Missing simulation scope.");
  const event = await models.Event.findById(eventId)
    .select("isSimulation simRunId")
    .lean();
  if (event && (!event.isSimulation || event.simRunId !== runId))
    throw Error("Simulation ownership mismatch.");
  // A recovered worker may already have removed the event before a late write settles.
  if (event || models.Event.collection.name === "qt_sim_event")
    for (const name of [
      "QueueEntry",
      "Seat",
      "Hold",
      "Pass",
      "Quota",
      "OrderKey",
      "Order",
      "Payment",
      "Ticket",
      "AuditLog",
    ])
      await models[name].deleteMany({ eventId });
  await models.User.deleteMany({ simRunId: runId, isBot: true });
  await models.Event.deleteOne({
    _id: eventId,
    simRunId: runId,
    isSimulation: true,
  });
}
export function proofFailures(r) {
  const failures = [];
  if (r.integrity.length) failures.push("Integrity violations");
  if (
    r.completedUsers !== r.users ||
    Object.keys(r.terminal).some(
      (s) =>
        !["completed", "expired_soldout", "expired", "abandoned"].includes(s),
    )
  )
    failures.push("Unfinished users");
  if (
    r.soldSeats !== r.tickets ||
    r.soldSeats !== r.paidSeatCount ||
    r.distinctTicketSeats !== r.tickets
  )
    failures.push("Paid seat or ticket mismatch");
  if (r.orderingViolations || r.peakActivePasses > r.maxActive)
    failures.push("Admission order or capacity");
  if (r.proof) {
    if (r.soldSeats !== r.seats) failures.push("Inventory did not sell out");
    if (
      !r.conflicts ||
      r.holdAttempts <= r.seats ||
      r.conflictRetries !== r.conflicts
    )
      failures.push("Insufficient contention or retries");
    if (
      r.profile === "greedy-2" &&
      (r.buyers !== r.seats / 2 ||
        r.users - r.buyers !== (r.terminal.expired_soldout ?? 0))
    )
      failures.push("Pair buyer or sold-out terminal count");
    if (r.profile === "mixed" && (r.buyers < r.seats / 2 || r.buyers > r.seats))
      failures.push("Mixed-profile buyer count");
  }
  return failures;
}
export async function runService({
  models,
  connection,
  config,
  runId = randomUUID(),
  eventId = new Types.ObjectId(),
  onProgress = async () => {},
  signal,
  hosted = false,
}) {
  assertSimulationStore(models, connection);
  const start = performance.now(),
    joins = [],
    holds = [];
  const result = {
    users: config.users,
    seats: config.seats,
    profile: config.profile,
    seed: config.seed,
    concurrency: config.concurrency,
    maxActive: config.maxActive,
    proof: !hosted && config.users * config.perUser > config.seats,
    holdAttempts: 0,
    conflicts: 0,
    conflictRetries: 0,
    abandonments: 0,
    failedPayments: 0,
    orderingViolations: 0,
    peakActivePasses: 0,
    peakWorkers: 0,
    timeline: [],
    unexpectedErrors: [],
  };
  let activeWorkers = 0,
    joined = 0;
  const progress = async (phase) => {
    signal?.throwIfAborted();
    await onProgress({
      phase,
      joined,
      holdAttempts: result.holdAttempts,
      conflicts: result.conflicts,
      timeline: result.timeline.slice(-32),
    });
  };
  try {
    await progress("Preparing fixture");
    const { clock, event, ids } = await seedFixture(
      models,
      config,
      runId,
      eventId,
      hosted ? runId : config.seed,
      undefined,
      hosted ? () => progress("Preparing fixture") : undefined,
    );
    const zero = +clock.now();
    const { booking, queue } = simulationRuntime(models, connection, clock);
    const timed = async (times, fn) => {
      const t = performance.now();
      try {
        return await fn();
      } finally {
        times.push(performance.now() - t);
      }
    };
    for (let offset = 0; offset < ids.length; offset += config.concurrency) {
      await progress("Joining lobby");
      await pool(
        ids.slice(offset, offset + config.concurrency),
        config.concurrency,
        (id) => timed(joins, () => queue.join(eventId, id)),
      );
      joined = Math.min(ids.length, offset + config.concurrency);
    }
    clock.advance(1000);
    await queue.finishOpening(eventId);
    const ranking = await models.QueueEntry.find({ eventId })
      .sort("number")
      .select("number userId")
      .lean();
    const expected = ids
      .map(String)
      .sort((a, b) =>
        digest(event.shuffleSeed + ":" + a).localeCompare(
          digest(event.shuffleSeed + ":" + b),
        ),
      );
    result.orderingViolations += ranking.filter(
      (entry, i) =>
        entry.number !== i + 1 || String(entry.userId) !== expected[i],
    ).length;
    const number = new Map(ranking.map((e) => [String(e.userId), e.number]));
    let last = 0;
    const unsubscribe = queue.subscribe(eventId, (notice) => {
      for (const item of notice.updates ?? [])
        if (item.type === "admitted") {
          const n = number.get(String(item.userId));
          if (n !== last + 1) result.orderingViolations++;
          last = n;
        }
    });
    try {
      for (let wave = 0; wave <= ids.length; wave++) {
        await progress("Admitting and booking");
        // Restore activity after a virtual expiry jump. The controller still decides every admission.
        for (const id of ids) queue.ping(eventId, id);
        await queue.admit(eventId);
        const admitted = await models.QueueEntry.find({
          eventId,
          status: "admitted",
        })
          .sort("number")
          .lean();
        const live = await models.Pass.countDocuments({
          eventId,
          status: "active",
          expiresAt: { $gt: clock.now() },
        });
        result.peakActivePasses = Math.max(result.peakActivePasses, live);
        if (!admitted.length) break;
        result.timeline.push({
          virtualSeconds: (+clock.now() - zero) / 1000,
          wallMs: Math.round(performance.now() - start),
          admitted: admitted.length,
          waiting: await models.QueueEntry.countDocuments({
            eventId,
            status: "waiting",
          }),
        });
        let pending = admitted;
        let retry = new Set();
        while (pending.length) {
          if (hosted) await progress("Admitting and booking");
          signal?.throwIfAborted();
          const proposals = await pool(
            pending,
            config.concurrency,
            async (row) => {
              const user = String(row.userId);
              if (retry.has(user)) result.conflictRetries++;
              const offer = await booking.bestAvailable(
                eventId,
                row.userId,
                "standard",
                2,
              );
              const seats = offer.seats.length
                ? offer.seats
                : config.profile === "mixed" || hosted
                  ? (offer.alternatives[0] ?? [])
                  : [];
              return { row, seats };
            },
          );
          retry = new Set();
          const outcomes = await pool(
            proposals,
            config.concurrency,
            async ({ row, seats }) => {
              signal?.throwIfAborted();
              if (!seats.length) return null;
              const user = String(row.userId),
                key = "hold-" + row.number + "-" + seats[0].id;
              result.peakWorkers = Math.max(
                result.peakWorkers,
                ++activeWorkers,
              );
              try {
                result.holdAttempts++;
                let hold;
                try {
                  hold = await timed(holds, () =>
                    booking.createHold(
                      eventId,
                      row.userId,
                      seats.map((s) => s.id),
                      key,
                    ),
                  );
                } catch (error) {
                  if (error.code !== "SEAT_UNAVAILABLE") throw error;
                  result.conflicts++;
                  retry.add(user);
                  return row;
                }
                const behavior =
                  config.profile === "mixed"
                    ? parseInt(
                        digest(config.seed + ":" + row.number).slice(0, 8),
                        16,
                      ) % 10
                    : 9;
                if (behavior < 2) {
                  result.abandonments++;
                  return null;
                }
                signal?.throwIfAborted();
                const order = await booking.createOrder(
                  eventId,
                  row.userId,
                  hold._id,
                  "order-" + row.number,
                );
                signal?.throwIfAborted();
                const failed = behavior === 2;
                const settled = await booking.confirmPayment({
                  orderId: order._id,
                  providerRef: "mock:" + order._id,
                  outcome: failed ? "failed" : "succeeded",
                });
                if (settled.order.status !== (failed ? "failed" : "paid"))
                  throw Error("Unexpected payment outcome.");
                if (failed) result.failedPayments++;
                return null;
              } finally {
                activeWorkers--;
              }
            },
          );
          pending = outcomes.filter(Boolean);
        }
        signal?.throwIfAborted();
        if (await queue.checkSoldOut(eventId)) break;
        clock.advance(601000);
        for (const id of ids) queue.ping(eventId, id);
        await queue.sweep(eventId);
      }
    } finally {
      unsubscribe();
    }
    await progress("Verifying inventory");
    const terminal = await models.QueueEntry.aggregate([
      { $match: { eventId } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    result.terminal = Object.fromEntries(terminal.map((x) => [x._id, x.n]));
    result.completedUsers = Object.entries(result.terminal)
      .filter(([s]) =>
        ["completed", "expired", "expired_soldout", "abandoned"].includes(s),
      )
      .reduce((s, [, n]) => s + n, 0);
    const paid = await models.Order.find({ eventId, status: "paid" })
      .select("seatIds paymentProvider")
      .lean();
    if (paid.some((o) => o.paymentProvider !== "mock"))
      throw Error("Unexpected simulation payment provider.");
    Object.assign(result, {
      buyers: paid.length,
      paidSeatCount: paid.reduce((n, o) => n + o.seatIds.length, 0),
      soldSeats: await models.Seat.countDocuments({ eventId, status: "sold" }),
      tickets: await models.Ticket.countDocuments({ eventId }),
      distinctTicketSeats: (await models.Ticket.distinct("seatId", { eventId }))
        .length,
      expiredHolds: await models.Hold.countDocuments({
        eventId,
        status: "expired",
      }),
      integrity: await booking.verifyEventIntegrity(eventId),
      join: latency(joins),
      hold: latency(holds),
      virtualSeconds: (+clock.now() - zero) / 1000,
    });
    result.failures = proofFailures(result);
    return result;
  } finally {
    if (!hosted) {
      await cleanFixture(models, runId, eventId);
      result.cleanup = "complete";
    }
    result.wallMs = Math.round(performance.now() - start);
  }
}
