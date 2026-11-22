import { useEffect, useState } from "react";

export function useServerTime(anchor, ticking = true) {
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    if (!anchor || !ticking) return;
    const timer = setInterval(() => setMeasured(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [anchor, ticking]);
  return anchor
    ? Date.parse(anchor.serverTime) + Math.max(0, measured - anchor.receivedAt)
    : null;
}

export function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return [Math.floor(seconds / 60), seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function saleState(event, now) {
  if (
    now >= Date.parse(event.startsAt) ||
    ["ended", "sold_out"].includes(event.status)
  )
    return "closed";
  if (now < Date.parse(event.saleStartsAt)) return "upcoming";
  return event.status === "on_sale" ? "open" : "waiting";
}
