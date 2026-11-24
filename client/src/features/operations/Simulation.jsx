import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Failure, Loading } from "../../ui.jsx";

const base = "/operations/simulation";
const active = (state) =>
  ["running", "cancelling", "recovering"].includes(state);
export function Simulation({ userId, request }) {
  const [users, setUsers] = useState("20"),
    [seats, setSeats] = useState("40"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const query = useQuery({
    queryKey: ["operations", userId, "simulation"],
    queryFn: ({ signal }) => request(base, { signal }),
    refetchInterval: (q) => (active(q.state.data?.run?.state) ? 2000 : 15000),
  });
  const run = query.data?.run,
    working = active(run?.state);
  async function act(cancel) {
    setError(null);
    setBusy(true);
    try {
      if (cancel) await request(base + "/" + run.runId, { method: "DELETE" });
      else
        await request(base, {
          method: "POST",
          body: { users: Number(users), seats: Number(seats) },
        });
    } catch (failure) {
      setError(failure);
    } finally {
      await query.refetch();
      setBusy(false);
    }
  }
  const result = run?.result,
    timeline = result?.timeline ?? run?.progress?.timeline;
  return (
    <section className="booking-card sim-section" aria-labelledby="sim-title">
      <h2 id="sim-title">Demo simulation</h2>
      <p className="support">
        Run a separate booking simulation with bot attendees and mock payments.
        Completed runs keep their results and remove their fixture data.
      </p>
      <form
        className="scanner-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!working && !busy && query.isSuccess) void act(false);
        }}
      >
        <fieldset
          disabled={working || busy || !query.isSuccess}
          className="sim-inputs"
        >
          <legend>Simulation settings</legend>
          <label>
            Bot count
            <input
              required
              type="number"
              min="1"
              max="300"
              value={users}
              onChange={(e) => setUsers(e.target.value)}
            />
          </label>
          <label>
            Seat count
            <input
              required
              type="number"
              min="1"
              max="2000"
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
            />
          </label>
        </fieldset>
        <button
          type="submit"
          className="primary-action"
          disabled={working || busy || !query.isSuccess}
        >
          Run demo simulation
        </button>
      </form>
      {query.isPending && <Loading>Checking simulation status…</Loading>}
      {query.isError && (
        <Failure error={query.error} retry={() => query.refetch()} />
      )}
      {error && <p role="alert">{error.message}</p>}
      {query.isSuccess && !run && <p>No simulation has run yet.</p>}
      {query.isSuccess && run && (
        <>
          <p role="status">
            Run {run.state}. Cleanup {run.cleanup}.
          </p>
          {run.startedAt && (
            <p className="support">
              {run.config.users} bots · {run.config.seats} seats · Started{" "}
              <time dateTime={run.startedAt}>
                {new Date(run.startedAt).toLocaleString()}
              </time>
            </p>
          )}
          {run.message && <p>{run.message}</p>}
          {working && run.progress && (
            <p>
              {run.progress.phase} · {run.progress.joined} of {run.config.users}{" "}
              joined
            </p>
          )}
          {run.state === "running" && (
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => act(true)}
            >
              Cancel simulation
            </button>
          )}
          {(result || run.progress) && (
            <dl className="ops-metrics">
              {Object.entries({
                "Hold attempts":
                  result?.holdAttempts ?? run.progress?.holdAttempts,
                "Seat conflicts": result?.conflicts ?? run.progress?.conflicts,
                Buyers: result?.buyers,
                "Sold seats": result?.soldSeats,
                Tickets: result?.tickets,
                "Peak active passes": result?.peakActivePasses,
                "Peak booking workers": result?.peakWorkers,
                "Peak DB commands/s": run.traffic?.peakPerSecond,
              })
                .filter(([, n]) => Number.isFinite(n))
                .map(([key, n]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{n}</dd>
                  </div>
                ))}
            </dl>
          )}
          {result && (
            <p>
              {result.integrity.length
                ? "Integrity failed"
                : "Integrity passed"}{" "}
              · {result.completedUsers} terminal attendees
            </p>
          )}
          {result?.failures?.map((issue) => (
            <p role="alert" key={issue}>
              {issue}
            </p>
          ))}
          {timeline?.length > 0 && (
            <details>
              <summary>Queue and admission timeline</summary>
              <table className="ops-table">
                <caption>Recorded simulation rounds</caption>
                <thead>
                  <tr>
                    <th scope="col">Virtual seconds</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Admitted</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((t) => (
                    <tr key={t.virtualSeconds}>
                      <td>{t.virtualSeconds}</td>
                      <td>{t.waiting}</td>
                      <td>{t.admitted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </section>
  );
}
