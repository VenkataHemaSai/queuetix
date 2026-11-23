import { ipKeyGenerator } from "express-rate-limit";
import { HttpError } from "./http.js";

export const clientIpKey = (request) =>
  ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "::");

export function requestLimit(
  clock,
  { limit, key, message, windowMs = 60_000, maxKeys = 10_000 },
) {
  const windows = new Map();
  return (request, response, next) => {
    const now = +clock.now();
    for (const [id, window] of windows) {
      if (window.endsAt > now) break;
      windows.delete(id);
    }
    const id = key(request);
    let record = windows.get(id);
    if (!record || record.endsAt <= now) {
      if (record) windows.delete(id);
      if (windows.size >= maxKeys) {
        const oldest = windows.values().next().value;
        return reject(response, next, oldest.endsAt - now, message);
      }
      record = { endsAt: now + windowMs, count: 0 };
      windows.set(id, record);
    }
    if (record.count >= limit)
      return reject(response, next, record.endsAt - now, message);
    record.count += 1;
    next();
  };
}

function reject(response, next, milliseconds, message) {
  response.set(
    "Retry-After",
    String(Math.max(1, Math.ceil(milliseconds / 1000))),
  );
  next(new HttpError(429, "RATE_LIMITED", message));
}
