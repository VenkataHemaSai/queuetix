import jwt from "jsonwebtoken";
import { passRequired, sameId } from "../booking/rules.js";

function channel(request, response, clock) {
  let closed = false;
  let heartbeat;
  let expiry;
  const cleanups = [];
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    for (const cleanup of cleanups) cleanup();
    if (response.headersSent && !response.writableEnded) response.end();
  }
  response.once("close", close);
  function write(value) {
    if (closed) return;
    if (!response.write(value)) close();
    else response.flush?.();
  }
  const send = (type, data) =>
    write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
  function open() {
    if (closed) return;
    response.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    heartbeat = setInterval(() => write(": heartbeat\n\n"), 15_000).unref();
    // The bearer token has already been verified by the attendee middleware.
    const claims = jwt.decode(request.get("Authorization").slice(7));
    expiry = setTimeout(
      close,
      Math.max(0, claims.exp * 1000 - +clock.now()),
    ).unref();
  }
  function consume(subscribe, process) {
    let notices = [];
    let ready = false;
    let running = false;
    async function drain() {
      if (running || !ready || closed) return;
      running = true;
      try {
        while (notices.length && !closed) {
          const batch = notices;
          notices = [];
          await process(batch);
        }
      } catch {
        close();
      } finally {
        running = false;
      }
    }
    cleanups.push(
      subscribe((notice) => {
        if (notices.length >= 128) {
          close();
          return;
        }
        notices.push(notice);
        void drain();
      }),
    );
    return () => {
      ready = true;
      void drain();
    };
  }
  return { open, close, consume, send, cleanups, isClosed: () => closed };
}

export function createQueueStreams(queue, booking) {
  const { clock } = queue;
  const pendingMetrics = new Map();
  function metrics(eventId) {
    const key = String(eventId);
    if (!pendingMetrics.has(key)) {
      pendingMetrics.set(
        key,
        queue.metrics(eventId).finally(() => pendingMetrics.delete(key)),
      );
    }
    return pendingMetrics.get(key);
  }

  async function queueStream(request, response, eventId, userId) {
    await queue.findEvent(eventId);
    const stream = channel(request, response, clock);
    stream.cleanups.push(queue.presence.connect(eventId, userId, clock.now()));
    let details;
    const resume = stream.consume(
      (listener) => queue.subscribe(eventId, listener),
      async (notices) => {
        let type = "queue";
        let refresh = false;
        for (const update of notices) {
          const own = update.userId && sameId(update.userId, userId);
          const individual = update.updates?.find((item) =>
            sameId(item.userId, userId),
          );
          if (own || individual || (!update.userId && !update.updates))
            refresh = true;
          if (update.type === "sold_out") type = "sold_out";
          if (own && update.type === "pass:expired") type = "pass:expired";
          if (own && update.type === "seat:sold") type = "order:confirmed";
          if (individual?.type === "admitted") type = "admitted";
        }
        if (refresh) details = await queue.individual(eventId, userId);
        stream.send(
          type,
          queue.view(eventId, userId, details, await metrics(eventId)),
        );
      },
    );

    try {
      details = await queue.individual(eventId, userId, true);
      const shared = await metrics(eventId);
      stream.open();
      stream.send("queue", queue.view(eventId, userId, details, shared));
      resume();
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  async function seatStream(request, response, eventId, userId) {
    const pass = await booking.activePass(eventId, userId);
    async function seatsBeforeExpiry() {
      const seats = await booking.listSeats(eventId, userId);
      if (pass.expiresAt <= clock.now()) throw passRequired();
      return seats;
    }
    const stream = channel(request, response, clock);
    stream.cleanups.push(queue.presence.connect(eventId, userId, clock.now()));
    let timer;
    const expire = () => {
      stream.send("pass:expired", {});
      stream.close();
    };
    const checkExpiry = () => {
      const left = +pass.expiresAt - +clock.now();
      if (left <= 0) expire();
      else if (!stream.isClosed())
        timer = setTimeout(checkExpiry, left).unref();
    };
    stream.cleanups.push(() => clearTimeout(timer));
    const resume = stream.consume(
      (listener) => queue.subscribe(eventId, listener),
      async (notices) => {
        const own = (notice) => notice.userId && sameId(notice.userId, userId);
        if (
          notices.some((notice) => own(notice) && notice.type === "seat:sold")
        ) {
          stream.send("order:confirmed", {});
          stream.close();
          return;
        }
        const changes = notices.filter((notice) =>
          notice.type.startsWith("seat:"),
        );
        if (
          !changes.length &&
          !notices.some(
            (notice) =>
              notice.type === "sold_out" ||
              (own(notice) && notice.type === "pass:expired"),
          )
        )
          return;
        try {
          const current = await booking.activePass(eventId, userId);
          if (!sameId(pass._id, current._id)) {
            expire();
            return;
          }
          if (!changes.length) return;
          const seats = await seatsBeforeExpiry();
          for (const notice of changes)
            stream.send(notice.type, { seatIds: notice.seatIds, seats });
        } catch (error) {
          if (error.code !== "PASS_REQUIRED") throw error;
          expire();
        }
      },
    );
    try {
      const seats = await seatsBeforeExpiry();
      stream.open();
      stream.send("snapshot", { seats });
      checkExpiry();
      resume();
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  return { queueStream, seatStream };
}
