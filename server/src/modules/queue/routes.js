import { Router } from "express";
import { z } from "zod";
import { validate } from "../../lib/http.js";
import { eventId } from "../events/event.validation.js";
import { fail } from "../booking/rules.js";
import { createQueueStreams } from "./streams.js";

const rejoinInput = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(128),
});
const entryView = ({ status, number, rejoinCount }) => ({
  status,
  number,
  rejoinCount,
});

export function queueRoutes(queue, booking, session) {
  const router = Router();
  const streams = createQueueStreams(queue, booking);
  const attendee = [
    session,
    (request, _response, next) => {
      if (request.user.role !== "attendee")
        throw fail(403, "FORBIDDEN", "An attendee account is required.");
      next();
    },
  ];
  const id = (request) => validate(eventId, request.params.id);
  const user = (request) => request.user._id;
  const base = "/events/:id/queue";
  router.post(base + "/join", attendee, async (req, res) =>
    res.json({
      entry: entryView(await queue.join(id(req), user(req))),
    }),
  );
  router.post(base + "/rejoin", attendee, async (req, res) =>
    res.json({
      entry: entryView(
        await queue.rejoin(
          id(req),
          user(req),
          validate(rejoinInput, req.body).idempotencyKey,
        ),
      ),
    }),
  );
  router.post(base + "/ping", attendee, (req, res) => {
    queue.ping(id(req), user(req));
    res.json({ ok: true });
  });
  router.get(base + "/me", attendee, async (req, res) =>
    res.json(await queue.me(id(req), user(req))),
  );
  router.head("/stream/queue/:id", attendee, (_req, res) =>
    res.status(405).end(),
  );
  router.head("/stream/seats/:id", attendee, (_req, res) =>
    res.status(405).end(),
  );
  router.get("/stream/queue/:id", attendee, (req, res) =>
    streams.queueStream(req, res, id(req), user(req)),
  );
  router.get("/stream/seats/:id", attendee, (req, res) =>
    streams.seatStream(req, res, id(req), user(req)),
  );
  return router;
}
