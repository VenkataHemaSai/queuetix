import { Router } from "express";
import { validate } from "../../lib/http.js";
import { requireRole } from "../auth/auth.routes.js";
import {
  createEventInput,
  editEventInput,
  eventId,
  pageInput,
  publishEventInput,
} from "./event.validation.js";

export function eventRoutes(events, session) {
  const router = Router();
  const id = (request) => validate(eventId, request.params.id);
  const owner = (request) => request.user._id;
  router.get("/events", async (request, response) => {
    response.json(await events.listPublic(validate(pageInput, request.query)));
  });
  router.get("/events/:id", async (request, response) => {
    response.json(await events.getPublic(id(request)));
  });
  router.use("/organizer/events", session, requireRole("organizer"));
  router.get("/organizer/events", async (request, response) => {
    response.json(
      await events.listOwned(
        owner(request),
        validate(pageInput, request.query),
      ),
    );
  });
  router.get("/organizer/events/:id", async (request, response) => {
    response.json({
      event: await events.getOwned(id(request), owner(request)),
    });
  });
  router.post("/organizer/events", async (request, response) => {
    const event = await events.create(
      validate(createEventInput, request.body),
      owner(request),
    );
    response.status(201).json({ event });
  });
  router.patch("/organizer/events/:id", async (request, response) => {
    const event = await events.edit(
      id(request),
      owner(request),
      validate(editEventInput, request.body),
    );
    response.json({ event });
  });
  router.post("/organizer/events/:id/publish", async (request, response) => {
    const { revision } = validate(publishEventInput, request.body);
    response.json({
      event: await events.publish(id(request), owner(request), revision),
    });
  });
  return router;
}
