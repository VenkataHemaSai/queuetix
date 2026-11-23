import { Router } from "express";
import { z } from "zod";
import { validate } from "../../lib/http.js";
import { requestLimit } from "../../lib/rate-limit.js";
import { requireRole } from "../auth/auth.routes.js";
import { publishedStatuses } from "../events/event.model.js";
import { eventId } from "../events/event.validation.js";
import { fail, missingEvent, sameId } from "../booking/rules.js";
import { verifyTicketPayload } from "../booking/signatures.js";

const scanInput = z.strictObject({
  eventId,
  payload: z.string().trim().min(1).max(200),
});
const published = { status: { $in: publishedStatuses }, isSimulation: false };
const invalid = () =>
  fail(422, "INVALID_TICKET", "This ticket is invalid for the selected event.");
const eventView = ({ _id, title, venue, startsAt, timeZone }) => ({
  id: String(_id),
  title,
  venue,
  startsAt,
  timeZone,
});

export function scannerRoutes({ models, clock, session, qrHmacSecret }) {
  const { Event, User, Seat, Order, Ticket } = models;
  const router = Router();
  const staff = [session, requireRole("staff")];
  const admin = [session, requireRole("admin")];
  const scanLimit = requestLimit(clock, {
    limit: 90,
    key: (req) => String(req.user._id),
    message: "Too many scan requests. Try again shortly.",
  });

  async function assigned(id, userId) {
    const event = await Event.findOne({
      _id: id,
      ...published,
      staffIds: userId,
    })
      .select("title venue startsAt timeZone")
      .lean();
    if (!event)
      throw fail(
        403,
        "EVENT_ACCESS_REQUIRED",
        "You are not assigned to this event.",
      );
    return event;
  }

  router.get("/staff/events", staff, async (req, res) => {
    const events = await Event.find({ ...published, staffIds: req.user._id })
      .select("title venue startsAt timeZone")
      .sort({ startsAt: -1 })
      .limit(100)
      .lean();
    res.json({ events: events.map(eventView) });
  });

  router.put(
    "/operations/events/:id/staff/:staffId",
    admin,
    async (req, res) => {
      const _id = validate(eventId, req.params.id);
      const staffId = validate(eventId, req.params.staffId);
      if (!(await User.exists({ _id: staffId, role: "staff", isGuest: false })))
        throw fail(
          404,
          "STAFF_NOT_FOUND",
          "No eligible staff account was found.",
        );
      const result = await Event.updateOne(
        { _id, ...published },
        { $addToSet: { staffIds: staffId } },
        { writeConcern: { w: "majority" } },
      );
      if (!result.matchedCount) throw missingEvent();
      res.status(204).end();
    },
  );

  router.delete(
    "/operations/events/:id/staff/:staffId",
    admin,
    async (req, res) => {
      const _id = validate(eventId, req.params.id);
      const staffId = validate(eventId, req.params.staffId);
      const result = await Event.updateOne(
        { _id, ...published },
        { $pull: { staffIds: staffId } },
        { writeConcern: { w: "majority" } },
      );
      if (!result.matchedCount) throw missingEvent();
      res.status(204).end();
    },
  );

  router.get("/staff/events/:id/scans", staff, async (req, res) => {
    const event = await assigned(
      validate(eventId, req.params.id),
      req.user._id,
    );
    const scans = await Ticket.find({
      eventId: event._id,
      status: "used",
      scannedAt: { $type: "date" },
    })
      .select("seatId scannedAt")
      .sort({ scannedAt: -1, _id: -1 })
      .limit(30)
      .lean();
    const seats = await Seat.find({
      eventId: event._id,
      _id: { $in: scans.map(({ seatId }) => seatId) },
    })
      .select("label section")
      .lean();
    const labels = new Map(
      seats.map((seat) => [
        String(seat._id),
        { label: seat.label, section: seat.section },
      ]),
    );
    res.json({
      event: eventView(event),
      scans: scans.map((scan) => ({
        id: String(scan._id),
        status: "used",
        scannedAt: scan.scannedAt,
        seat: labels.get(String(scan.seatId)) ?? null,
      })),
    });
  });

  router.post("/tickets/validate", staff, scanLimit, async (req, res) => {
    const { eventId, payload } = validate(scanInput, req.body);
    const event = await assigned(eventId, req.user._id);
    const _id = verifyTicketPayload(payload, qrHmacSecret);
    if (!_id) throw invalid();
    const match = { _id, eventId, qrPayload: payload };
    const ticket = await Ticket.findOne(match)
      .select("status scannedAt orderId seatId userId")
      .lean();
    if (!ticket || !["valid", "used"].includes(ticket.status)) throw invalid();
    const [seat, order] = await Promise.all([
      Seat.findOne({
        _id: ticket.seatId,
        eventId,
        orderId: ticket.orderId,
        status: "sold",
      })
        .select("label section")
        .lean(),
      Order.findOne({
        _id: ticket.orderId,
        eventId,
        userId: ticket.userId,
        status: "paid",
      })
        .select("seatIds")
        .lean(),
    ]);
    if (!seat || !order?.seatIds.some((id) => sameId(id, seat._id)))
      throw invalid();
    const view = {
      event: eventView(event),
      seat: { label: seat.label, section: seat.section },
    };
    const redeemed = await Ticket.findOneAndUpdate(
      { ...match, status: "valid" },
      {
        $set: {
          status: "used",
          scannedAt: clock.now(),
          scannedBy: req.user._id,
        },
      },
      { new: true, projection: "scannedAt", writeConcern: { w: "majority" } },
    ).lean();
    if (redeemed)
      return res.json({
        status: "valid",
        ...view,
        scannedAt: redeemed.scannedAt,
      });
    const used = await Ticket.findOne({ ...match, status: "used" })
      .select("scannedAt")
      .readConcern("majority")
      .lean();
    if (!used) throw invalid();
    throw fail(409, "ALREADY_USED", "This ticket has already been used.", {
      ...view,
      scannedAt: used.scannedAt,
    });
  });
  return router;
}
