import { useEffect, useState } from "react";
import { readApiOrigin, runProbes } from "./probes.js";

const apiOrigin = readApiOrigin(import.meta.env.VITE_API_URL);
const checks = [
  ["api", "API"],
  ["db", "Database"],
  ["txn", "Transaction"],
  ["cors", "CORS"],
  ["sse", "Incremental SSE"],
];

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function Stamp({ value, precise = false }) {
  if (!value) return null;
  return (
    <time dateTime={value} title={value}>
      {(precise ? clockFormat : dateFormat).format(new Date(value))}
    </time>
  );
}

function CheckRow({ name, result, running }) {
  const status = result?.status ?? "NOT CHECKED";
  const detail =
    result?.detail ??
    (running ? "Waiting for the check to finish." : "No result is available.");
  const color =
    status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "pending";
  return (
    <li className="check-row">
      <div>
        <h3>{name}</h3>
        <p>{detail}</p>
        {result?.checkedAt && (
          <p className="stamp">
            <Stamp value={result.checkedAt} />
          </p>
        )}
      </div>
      <span className={`verdict verdict-${color}`}>{status}</span>
    </li>
  );
}

function TickLog({ ticks, running }) {
  return (
    <section aria-labelledby="tick-title" className="panel stream-panel">
      <div className="panel-heading">
        <h2 id="tick-title">Stream arrivals</h2>
        <p>Browser receipt times in your local time zone.</p>
      </div>
      {ticks.length === 0 ? (
        <p className="stream-empty">
          {running ? "Waiting for the first tick." : "No ticks received."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Tick</th>
              <th scope="col">Received</th>
              <th scope="col">Gap</th>
            </tr>
          </thead>
          <tbody>
            {ticks.map(({ number, receivedAt, gap }) => (
              <tr key={number}>
                <th scope="row">{number}</th>
                <td>
                  <Stamp value={receivedAt} precise />
                </td>
                <td>{gap === null ? "—" : `${(gap / 1000).toFixed(2)} s`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="stream-foot">
        Expected cadence is one tick about every two seconds.
      </p>
    </section>
  );
}

export function SmokePage() {
  const [run, setRun] = useState(0);
  const [results, setResults] = useState({});
  const [ticks, setTicks] = useState([]);
  const [running, setRunning] = useState(Boolean(apiOrigin));
  const [slow, setSlow] = useState(false);
  const [finished, setFinished] = useState(null);
  useEffect(() => {
    if (!apiOrigin) return;
    const controller = new AbortController();
    const { signal } = controller;
    const slowTimer = setTimeout(() => setSlow(true), 5000);
    const update = (key, result) => {
      if (signal.aborted) return;
      if (key === "api") {
        clearTimeout(slowTimer);
        setSlow(false);
      }
      setResults((previous) => ({ ...previous, [key]: result }));
    };
    runProbes(apiOrigin, signal, update, (tick) => {
      if (!signal.aborted) setTicks((previous) => [...previous, tick]);
    }).then(() => {
      if (!signal.aborted) {
        setRunning(false);
        setFinished(new Date().toISOString());
      }
    });
    return () => {
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [run]);

  function rerun() {
    if (!apiOrigin || running) return;
    setResults({});
    setTicks([]);
    setFinished(null);
    setRunning(true);
    setRun((previous) => previous + 1);
  }

  const failures = Object.values(results).filter(
    ({ status }) => status === "FAIL",
  ).length;
  return (
    <main id="main-content" className="shell page">
      <div className="intro">
        <div>
          <h1>Service checks</h1>
          <p>
            Check the API, its database startup probe, and whether events reach
            this browser as they’re sent.
          </p>
        </div>
        <button
          type="button"
          disabled={!apiOrigin}
          aria-disabled={running || !apiOrigin}
          onClick={rerun}
        >
          {running ? "Running checks" : "Run checks"}
        </button>
      </div>
      <div className="run-context">
        <dl className="origin">
          <dt>API origin</dt>
          <dd>{apiOrigin ?? "Unconfigured"}</dd>
        </dl>
        <p role="status" className="run-status">
          {!apiOrigin &&
            "Set VITE_API_URL to the API origin, then rebuild the client."}
          {running &&
            (slow
              ? "Still connecting. The server may be waking up."
              : "Checks are running.")}
          {finished && (
            <>
              {failures
                ? `Checks finished with ${failures} failed.`
                : "Checks finished."}{" "}
              <Stamp value={finished} />
            </>
          )}
        </p>
      </div>
      <div className="smoke-grid">
        <section className="panel" aria-labelledby="checks-title">
          <div className="panel-heading">
            <h2 id="checks-title">Results</h2>
            <p>
              Database and transaction results reflect the server’s last startup
              probe.
            </p>
          </div>
          <ul className="check-list">
            {checks.map(([key, name]) => (
              <CheckRow
                key={key}
                name={name}
                result={results[key]}
                running={running}
              />
            ))}
          </ul>
        </section>
        <TickLog ticks={ticks} running={running} />
      </div>
    </main>
  );
}
