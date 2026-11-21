import { PRODUCT_NAME } from "../product.js";

const timestamp = () => new Date().toISOString();
const isTimestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const codes = {
  DB_SMOKE_CONNECTION_FAILED:
    "The server could not connect to MongoDB at startup.",
  DB_SMOKE_MONGO_FAILED: "The startup ping or write/read check failed.",
  DB_SMOKE_CLEANUP_FAILED:
    "The startup probe could not remove all its test records.",
  DB_SMOKE_TRANSACTION_FAILED:
    "The two-collection transaction did not pass. See the server logs.",
};

export function readApiOrigin(value) {
  try {
    const url = new URL(value);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      [url.origin, `${url.origin}/`].includes(value)
    ) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}

async function json(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`Expected a JSON response (HTTP ${response.status}).`);
  }
  return response.json();
}

function failure(error, signal) {
  if (signal.aborted) return "The check timed out. Run it again to retry.";
  if (error instanceof TypeError)
    return "The browser could not reach the API or read its response. Check the connection and allowed origin.";
  return error.message;
}

function outcome(status, detail, checkedAt = timestamp()) {
  return { status, detail, checkedAt };
}

async function checkApi(fetchProbe, update) {
  const start = performance.now();
  const response = await fetchProbe("/health");
  const data = await json(response);
  if (
    !response.ok ||
    data.ok !== true ||
    data.service !== PRODUCT_NAME ||
    !isTimestamp(data.time) ||
    typeof data.version !== "string"
  ) {
    throw new Error(
      `The API returned an unexpected health response (HTTP ${response.status}).`,
    );
  }
  update(
    "api",
    outcome(
      "PASS",
      `Version ${data.version} responded in ${Math.round(performance.now() - start)} ms.`,
    ),
  );
}

async function checkDatabase(fetchProbe, update) {
  const response = await fetchProbe("/health/db");
  const data = await json(response);
  const validStatus = (value) => value === null || typeof value === "boolean";
  if (
    ![200, 503].includes(response.status) ||
    !validStatus(data.mongo) ||
    !validStatus(data.txn) ||
    (data.checkedAt !== null &&
      (!isTimestamp(data.checkedAt) || !Number.isFinite(data.latencyMs))) ||
    (data.checkedAt === null && (data.mongo !== null || data.txn !== null)) ||
    (data.txn !== null && data.mongo !== true) ||
    (response.ok &&
      (data.ok !== true || data.mongo !== true || data.txn !== true))
  ) {
    throw new Error(
      `The API did not return a usable startup result (HTTP ${response.status}).`,
    );
  }
  const mongoDetail = codes[data.code] ?? "The startup database check failed.";
  if (data.mongo === null) {
    update(
      "db",
      outcome(
        "NOT CHECKED",
        "The server has no completed startup probe.",
        null,
      ),
    );
  } else if (!data.mongo || data.code === "DB_SMOKE_CLEANUP_FAILED") {
    update("db", outcome("FAIL", mongoDetail, data.checkedAt));
  } else {
    update(
      "db",
      outcome(
        "PASS",
        `Ping and write/read succeeded. Probe took ${data.latencyMs} ms.`,
        data.checkedAt,
      ),
    );
  }
  const transaction =
    data.txn === true
      ? outcome(
          "PASS",
          "Committed writes were read back from both collections.",
          data.checkedAt,
        )
      : data.txn === false
        ? outcome("FAIL", codes.DB_SMOKE_TRANSACTION_FAILED, data.checkedAt)
        : outcome(
            "NOT CHECKED",
            "No completed transaction result is available.",
            null,
          );
  update("txn", transaction);
}

async function checkCors(fetchProbe, update) {
  const response = await fetchProbe("/health/cors", {
    headers: { Authorization: "QueueTix smoke" },
  });
  const data = await json(response);
  if (!response.ok || data.ok !== true)
    throw new Error(
      `The Authorization request failed (HTTP ${response.status}).`,
    );
  update(
    "cors",
    outcome(
      "PASS",
      "The browser’s Authorization preflight and request succeeded.",
    ),
  );
}

async function checkStream(fetchProbe, update, appendTick) {
  const response = await fetchProbe("/health/sse");
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("text/event-stream") ||
    !response.body
  ) {
    throw new Error(
      `The API did not open an event stream (HTTP ${response.status}).`,
    );
  }
  let buffer = "";
  let ticks = 0;
  let irregular = false;
  let done = false;
  let previous;
  for await (const chunk of response.body.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    if (buffer.length > 4096)
      throw new Error("The API sent an oversized stream frame.");
    for (const frame of frames) {
      const received = performance.now();
      const event = /^event: (tick|done)\r?\ndata: (.+)$/.exec(frame);
      if (!event || done)
        throw new Error("The API sent an unexpected stream event.");
      let data;
      try {
        data = JSON.parse(event[2]);
      } catch {
        throw new Error("The API sent invalid stream data.");
      }
      if (!isTimestamp(data?.time))
        throw new Error("A stream event was missing its server timestamp.");
      if (event[1] === "done") {
        if (ticks !== 10)
          throw new Error("The stream sent done before all ten ticks arrived.");
        done = true;
        continue;
      }
      ticks += 1;
      if (data.tick !== ticks || ticks > 10)
        throw new Error("The API sent an out-of-order stream tick.");
      const gap =
        previous === undefined ? null : Math.round(received - previous);
      if (gap !== null && (gap < 1200 || gap > 3800)) irregular = true;
      appendTick({ number: ticks, receivedAt: timestamp(), gap });
      previous = received;
    }
  }
  if (!done || buffer.trim())
    throw new Error("The stream closed without a complete done event.");
  if (irregular)
    throw new Error(
      "Ticks arrived in a burst or outside the expected two-second cadence.",
    );
  update(
    "sse",
    outcome(
      "PASS",
      "Ten spaced ticks arrived, followed by done and stream closure.",
    ),
  );
}

export async function runProbes(origin, cancelled, update, appendTick) {
  const sameOrigin = origin === window.location.origin;
  const tasks = [
    ["api", checkApi],
    ["db", checkDatabase],
    ["cors", checkCors],
    ["sse", checkStream],
  ];
  await Promise.all(
    tasks.map(async ([key, run]) => {
      if (key === "cors" && sameOrigin) {
        update(
          "cors",
          outcome(
            "NOT CHECKED",
            "Use separate browser and API origins to test preflight.",
            null,
          ),
        );
        return;
      }
      const signal = AbortSignal.any([
        cancelled,
        AbortSignal.timeout(key === "sse" ? 115_000 : 90_000),
      ]);
      const fetchProbe = (path, options) =>
        fetch(`${origin}${path}`, {
          ...options,
          signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
      try {
        await run(fetchProbe, update, appendTick);
      } catch (error) {
        if (cancelled.aborted) return;
        update(key, outcome("FAIL", failure(error, signal)));
        if (key === "db")
          update(
            "txn",
            outcome(
              "NOT CHECKED",
              "The browser could not read a transaction result.",
              null,
            ),
          );
      }
    }),
  );
}
