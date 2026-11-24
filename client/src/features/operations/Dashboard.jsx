import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Empty, Failure, Loading, Pagination } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { formatDate, pageNumber, statusNames } from "../events/presentation.js";
import { OperationsAccess } from "./access.jsx";
import { Simulation } from "./Simulation.jsx";
import { EventMetricValues, useEventMetrics } from "./EventMetrics.jsx";

const roles = ["organizer", "admin"];

function EventList() {
  const { user, request } = useSession();
  const [params] = useSearchParams();
  const page = pageNumber(params);
  const query = useQuery({
    queryKey: ["operations", user.id, "events", page],
    queryFn: ({ signal }) =>
      request("/operations/events?page=" + page, { signal }),
  });
  return (
    <main id="main-content" className="shell product-page ops-page">
      <h1>Event operations</h1>
      {user.role === "admin" && (
        <Simulation userId={user.id} request={request} />
      )}
      {query.isPending && <Loading>Loading events…</Loading>}
      {query.isError && (
        <Failure error={query.error} retry={() => query.refetch()} />
      )}
      {query.data &&
        (query.data.events.length ? (
          <>
            <ul className="ops-events">
              {query.data.events.map((event) => (
                <li className="booking-card" key={event.id}>
                  <div>
                    <h2>
                      <Link to={"/operations/events/" + event.id}>
                        {event.title}
                      </Link>
                    </h2>
                    <time dateTime={event.startsAt}>
                      {formatDate(event.startsAt, event.timeZone)}
                    </time>
                  </div>
                  <span className="status-tag">
                    {statusNames[event.status]}
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              path="/operations/events"
              page={page}
              hasNext={query.data.hasNext}
            />
          </>
        ) : (
          <Empty title="No published events">
            Published events you can manage appear here.
          </Empty>
        ))}
    </main>
  );
}

function Admissions({ data }) {
  const peak = Math.max(0, ...data.admissions.map(({ count }) => count));
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone: data.event.timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <section className="booking-card" aria-labelledby="admissions-heading">
      <h2 id="admissions-heading">Admissions per minute</h2>
      <p className="support">
        Counts come from recorded admission passes. The current minute is
        partial.
      </p>
      {peak ? (
        <>
          <div className="ops-chart" aria-hidden="true">
            {data.admissions.map(({ start, count }) => (
              <div key={start}>
                <span style={{ height: (count / peak) * 100 + "%" }} />
              </div>
            ))}
          </div>
          <details>
            <summary>View admission figures</summary>
            <table className="ops-table">
              <caption className="sr-only">
                Recorded admissions per minute
              </caption>
              <thead>
                <tr>
                  <th scope="col">Minute</th>
                  <th scope="col">Admissions</th>
                </tr>
              </thead>
              <tbody>
                {data.admissions.map(({ start, count }) => (
                  <tr key={start}>
                    <th scope="row">
                      <time dateTime={start}>
                        {time.format(new Date(start))}
                      </time>
                    </th>
                    <td>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p>No admissions were recorded in this window.</p>
      )}
    </section>
  );
}

function Integrity({ id, zone, request }) {
  const [lastCompleted, setLastCompleted] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState(null);
  async function run() {
    if (busy) return;
    setBusy(true);
    setFault(null);
    try {
      setLastCompleted(
        await request("/operations/events/" + id + "/integrity", {
          method: "POST",
        }),
      );
    } catch (error) {
      setFault(error);
    } finally {
      setBusy(false);
    }
  }
  const checkTime = lastCompleted && (
    <time dateTime={lastCompleted.checkedAt}>
      {formatDate(lastCompleted.checkedAt, zone)}
    </time>
  );
  return (
    <section className="booking-card" aria-labelledby="integrity-heading">
      <h2 id="integrity-heading">Inventory integrity</h2>
      <p className="support">
        Check seat ownership, tickets and booking counts for this event.
      </p>
      <button type="button" disabled={busy} onClick={run}>
        Run integrity check
      </button>
      {busy && <Loading>Checking event integrity…</Loading>}
      {fault && (
        <>
          <p>
            <strong>Latest check could not complete.</strong>
          </p>
          <Failure error={fault} />
        </>
      )}
      {lastCompleted && (busy || fault) && (
        <p className="support">
          Last completed check · {lastCompleted.status} · {checkTime}
        </p>
      )}
      {lastCompleted && !busy && !fault && (
        <div
          className={
            "notice" + (lastCompleted.status === "FAIL" ? " notice-error" : "")
          }
        >
          <p role="status">
            <strong>{lastCompleted.status}</strong> · {checkTime}
          </p>
          {lastCompleted.issues.length > 0 && (
            <>
              <ul>
                {lastCompleted.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
              {lastCompleted.issueCount > lastCompleted.issues.length && (
                <p>
                  {lastCompleted.issueCount - lastCompleted.issues.length} more
                  issues.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function EventDashboard() {
  const { id } = useParams();
  const { request, user } = useSession();
  const query = useEventMetrics(id);
  const data = query.data;
  return (
    <main id="main-content" className="shell product-page ops-page">
      <Link className="back-link" to="/operations/events">
        All operations events
      </Link>
      <div className="page-top">
        <h1>{data?.event.title ?? "Event operations"}</h1>
        {query.isSuccess && user.role === "organizer" && (
          <Link className="secondary-action" to={`/organizer/events/${id}`}>
            Manage Event
          </Link>
        )}
      </div>
      {query.isPending && <Loading>Loading event metrics…</Loading>}
      {query.isError && (
        <Failure error={query.error} retry={() => query.refetch()} />
      )}
      {data && (
        <>
          <div className="ops-meta">
            <span className="status-tag">{statusNames[data.event.status]}</span>
            <p className="support">
              Last updated{" "}
              <time dateTime={data.asOf}>
                {formatDate(data.asOf, data.event.timeZone)}
              </time>
            </p>
            <button
              className="secondary-action"
              type="button"
              disabled={query.isFetching}
              onClick={() => query.refetch()}
            >
              Refresh metrics
            </button>
          </div>
          <EventMetricValues values={data.metrics} />
          {data.metrics.availableSeats === null && (
            <p className="notice notice-error">
              Seat inventory could not be verified.
            </p>
          )}
          <div className="ops-sections">
            <Admissions data={data} />
            <Integrity
              key={id}
              id={id}
              zone={data.event.timeZone}
              request={request}
            />
          </div>
        </>
      )}
    </main>
  );
}

export function Dashboard({ detail }) {
  return (
    <OperationsAccess roles={roles} title="Operations">
      {detail ? <EventDashboard /> : <EventList />}
    </OperationsAccess>
  );
}
