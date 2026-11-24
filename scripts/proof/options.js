import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
export function parseOptions(args) {
  const { values: v } = parseArgs({
    args,
    options: Object.fromEntries(
      [
        "mode",
        "users",
        "seats",
        "concurrency",
        "seed",
        "profile",
        "streams",
        "fixture",
        "output",
      ].map((key) => [key, { type: "string" }]),
    ),
  });
  const mode = v.mode ?? "service",
    name =
      v.fixture ??
      (mode === "http" || Number(v.seats) >= 100 ? "big-show" : "small-show");
  if (
    !["small-show", "big-show"].includes(name) ||
    !["service", "http"].includes(mode)
  )
    throw Error("Unknown fixture or mode.");
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../fixtures/" + name + ".json", import.meta.url),
      "utf8",
    ),
  );
  function integer(value, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw Error("Invalid simulation limit.");
    return n;
  }
  const users = integer(
    v.users ?? (mode === "http" ? 500 : fixture.users),
    mode === "http" ? 500 : 5000,
  );
  const profile = v.profile ?? "greedy-2",
    seed = v.seed ?? "queue-proof";
  if (
    !["greedy-2", "mixed"].includes(profile) ||
    !seed.length ||
    seed.length > 64
  )
    throw Error("Invalid profile or seed.");
  return {
    ...fixture,
    mode,
    profile,
    seed,
    users,
    seats: integer(v.seats ?? (mode === "http" ? 10 : fixture.seats), 2000),
    concurrency: integer(v.concurrency ?? (mode === "http" ? 16 : 20), 200),
    streams: integer(v.streams ?? Math.min(users, 100), Math.min(users, 100)),
    output: v.output,
  };
}
export function assertDisposable(uri, name) {
  const url = new URL(uri);
  if (
    url.protocol !== "mongodb:" ||
    url.hostname !== "127.0.0.1" ||
    !/^qt_proof_[a-z0-9]+$/.test(name) ||
    url.pathname !== "/" + name ||
    url.username ||
    url.password ||
    !url.searchParams.has("replicaSet")
  )
    throw Error("A private loopback proof replica set is required.");
}
