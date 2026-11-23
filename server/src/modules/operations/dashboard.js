import { Router } from "express";
import { validate } from "../../lib/http.js";
import { requestLimit } from "../../lib/rate-limit.js";
import { eventId, pageInput } from "../events/event.validation.js";
import { publishedStatuses } from "../events/event.model.js";
import { fail, missingEvent } from "../booking/rules.js";
import { seatInventoryIssue } from "../booking/integrity.js";

const minute = 60_000;
const eventSelector = "title status startsAt timeZone totalSeats";
const scope = (user) => ({
  isSimulation: false,
  status: { $in: publishedStatuses },
  ...(user.role === "organizer" && { organizerId: user._id }),
});
const view = ({ _id, title, startsAt, timeZone, status }) => ({
  id: String(_id),
  title,
  startsAt,
  timeZone,
  status,
});
function requireOperations(req, _res, next) {
  if (req.user.isGuest || !["organizer", "admin"].includes(req.user.role))
    throw fail(
      403,
      "FORBIDDEN",
      "An organizer or administrator account is required.",
    );
  next();
}

export function dashboardRoutes({ models, booking, queue, clock, session }) {
  const { Event, QueueEntry, Pass, Hold } = models;
  const router = Router();
  const access = [session, requireOperations];
  const cache = new Map();
  let checking = false;
  const metricLimit = requestLimit(clock, {
    limit: 40,
    key: (req) => String(req.user._id),
    message: "Too many dashboard requests. Try again shortly.",
  });
  const checkLimit = requestLimit(clock, {
    limit: 1,
    key: (req) => String(req.event._id),
    windowMs: 30_000,
    maxKeys: 1000,
    message: "Wait before running another integrity check for this event.",
  });

  async function eventAccess(req, _res, next) {
    const id = validate(eventId, req.params.id);
    req.event = await Event.findOne({ _id: id, ...scope(req.user) })
      .select(eventSelector)
      .lean();
    if (!req.event) throw missingEvent();
    next();
  }

  async function measure(event) {
    const now = clock.now();
    const eventId = event._id;
    const minuteStart = Math.floor(+now / minute) * minute;
    const firstBucket = minuteStart - 9 * minute;
    const active = { eventId, status: "active", expiresAt: { $gt: now } };
    const [queueLength, activeAdmissions, activeHolds, stock, admissions] =
      await Promise.all([
        QueueEntry.countDocuments({
          eventId,
          status: { $in: ["lobby", "waiting"] },
        }),
        Pass.countDocuments(active),
        Hold.countDocuments(active),
        queue.inventory(event, null, now).catch((error) => {
          if (
            error.code === "QUEUE_INTEGRITY" &&
            error.issue === seatInventoryIssue
          )
            return null;
          throw error;
        }),
        Pass.aggregate([
          {
            $match: {
              eventId,
              issuedAt: { $gte: new Date(firstBucket), $lte: now },
            },
          },
          {
            $group: {
              _id: { $dateTrunc: { date: "$issuedAt", unit: "minute" } },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);
    return {
      event: view(event),
      metrics: {
        queueLength,
        activeAdmissions,
        activeHolds,
        availableSeats: stock?.available ?? null,
        reclaimableSeats: stock?.reclaimable ?? null,
        soldSeats: stock?.sold ?? null,
      },
      admissions: Array.from({ length: 10 }, (_, index) => {
        const start = firstBucket + index * minute;
        return {
          start: new Date(start),
          count: admissions.find(({ _id }) => +_id === start)?.count ?? 0,
        };
      }),
      asOf: now,
    };
  }

  router.get("/operations/events", access, metricLimit, async (req, res) => {
    const { page, limit } = validate(pageInput, req.query);
    const events = await Event.find(scope(req.user))
      .select(eventSelector)
      .sort({ startsAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .lean();
    res.json({
      events: events.slice(0, limit).map(view),
      page,
      hasNext: events.length > limit,
    });
  });

  router.get(
    "/operations/events/:id",
    access,
    metricLimit,
    eventAccess,
    async (req, res) => {
      const key = String(req.event._id);
      let entry = cache.get(key);
      if (
        !entry ||
        +clock.now() >= entry.expiresAt ||
        entry.status !== req.event.status
      ) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        entry = {
          expiresAt: +clock.now() + 5_000,
          status: req.event.status,
          result: measure(req.event),
        };
        cache.set(key, entry);
      }
      try {
        res.json(await entry.result);
      } catch (error) {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
    },
  );

  router.post(
    "/operations/events/:id/integrity",
    access,
    eventAccess,
    checkLimit,
    async (req, res) => {
      if (checking) {
        res.set("Retry-After", "30");
        throw fail(
          429,
          "INTEGRITY_BUSY",
          "An integrity check is already running. Try again shortly.",
        );
      }
      checking = true;
      try {
        const issues = await booking.verifyEventIntegrity(req.event._id, {
          preSweep: true,
        });
        res.json({
          status: issues.length ? "FAIL" : "PASS",
          checkedAt: clock.now(),
          issueCount: issues.length,
          issues: issues.slice(0, 12),
        });
      } finally {
        checking = false;
      }
    },
  );
  return router;
}
