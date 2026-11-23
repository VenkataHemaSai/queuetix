const connectionWindow = 30_000;
const grace = 45_000;

export function createPresence() {
  const activity = new Map();
  const key = (eventId, userId) => String(eventId) + ":" + String(userId);
  function record(eventId, userId) {
    const id = key(eventId, userId);
    if (!activity.has(id))
      activity.set(id, { eventId, userId, streams: new Set() });
    return activity.get(id);
  }
  function touch(eventId, userId, now) {
    const state = record(eventId, userId);
    state.lastSeen = +now;
    state.disconnected = false;
  }
  function connect(eventId, userId, now) {
    touch(eventId, userId, now);
    const state = record(eventId, userId);
    const stream = Symbol();
    state.streams.add(stream);
    return () => {
      if (state.streams.delete(stream) && state.streams.size === 0)
        state.disconnected = true;
    };
  }
  function protect(eventId, userId, now) {
    record(eventId, userId).protectedUntil = +now + grace;
  }
  function status(eventId, userId, now) {
    const state = activity.get(key(eventId, userId));
    const lastSeen = state?.lastSeen ?? -Infinity;
    const age = +now - lastSeen;
    if (age <= connectionWindow && !state.disconnected) return "connected";
    if (age <= grace || +now <= state?.protectedUntil) return "protected";
    return "timed_out";
  }
  function prune(now) {
    for (const [id, state] of activity) {
      const until = Math.max(
        (state.lastSeen ?? -Infinity) + grace,
        state.protectedUntil ?? -Infinity,
      );
      if (!state.streams.size && +now > until + 120_000) activity.delete(id);
    }
  }
  function timedOut(now) {
    const events = new Map();
    for (const { eventId, userId } of activity.values()) {
      if (status(eventId, userId, now) !== "timed_out") continue;
      const key = String(eventId);
      if (!events.has(key)) events.set(key, []);
      events.get(key).push(userId);
    }
    return events;
  }
  return {
    touch,
    connect,
    protect,
    status,
    prune,
    timedOut,
    reset: () => activity.clear(),
  };
}
