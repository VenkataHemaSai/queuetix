export function createQueueHub() {
  const channels = new Map();
  function subscribe(eventId, listener) {
    const key = String(eventId);
    if (!channels.has(key)) channels.set(key, new Set());
    const listeners = channels.get(key);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) channels.delete(key);
    };
  }
  function publish(eventId, type, details = {}) {
    for (const listener of channels.get(String(eventId)) ?? [])
      listener({ type, ...details });
  }
  return { subscribe, publish };
}
