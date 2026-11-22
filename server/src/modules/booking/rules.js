import { Types } from "mongoose";
import { HttpError } from "../../lib/http.js";

export const objectId = (value) => /^[a-f\d]{24}$/i.test(String(value));
export const newId = () => new Types.ObjectId();
export const expires = (now, seconds) =>
  new Date(now.getTime() + seconds * 1000);
export const sameId = (a, b) => String(a) === String(b);
export const fail = (status, code, message, fields) =>
  new HttpError(status, code, message, fields);
export const missingEvent = () =>
  fail(404, "EVENT_NOT_FOUND", "Event not found.");
export const passRequired = () =>
  fail(403, "PASS_REQUIRED", "An active admission pass is required.");
export const missingOrder = () =>
  fail(404, "ORDER_NOT_FOUND", "Order not found.");
export const alreadyBooked = () =>
  fail(
    409,
    "ALREADY_BOOKED",
    "You already have a paid booking for this event.",
  );

export function requireSale(event, now) {
  if (!event || event.status === "draft") throw missingEvent();
  if (
    event.status !== "on_sale" ||
    now < event.saleStartsAt ||
    now >= event.startsAt
  ) {
    throw fail(409, "SALE_CLOSED", "This event is outside its booking window.");
  }
}

export function sameRequest(record, signature) {
  if (record.requestFingerprint !== signature) {
    throw fail(
      409,
      "IDEMPOTENCY_CONFLICT",
      "This request key was already used for different details.",
    );
  }
  return record;
}
