import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { templates } from "../../../../shared/seat-layout.js";
import { api } from "../../lib/api.js";
import { Empty, Failure, Loading, Pagination } from "../../ui.jsx";
import { SeatMap } from "./SeatMap.jsx";
import { useSession } from "../auth/session.jsx";
import { saleState } from "../booking/time.js";
import {
  formatDate,
  formatPrice,
  pageNumber,
  statusNames,
} from "./presentation.js";

export function EventCover({ type }) {
  return (
    <div aria-hidden="true" className={`event-cover cover-${type}`}>
      <span />
      <span />
      <span />
    </div>
  );
}

function EventCard({ event }) {
  const lowest = Math.min(...Object.values(event.tierPrices));
  return (
    <article className="event-card">
      <Link to={`/events/${event.id}`} className="event-card-link">
        <EventCover type={event.type} />
        <div className="event-card-copy">
          <div className="event-labels">
            <span>{templates[event.type].name}</span>
            {event.isDemo && <span className="status-tag">Demo event</span>}
          </div>
          <h3>{event.title}</h3>
          <time dateTime={event.startsAt}>
            {formatDate(event.startsAt, event.timeZone)}
          </time>
          <p>{event.venue}</p>
          <strong className="card-price">
            From {formatPrice(lowest, event.currency)}
          </strong>
        </div>
      </Link>
    </article>
  );
}

export function Events({ home = false }) {
  const [params] = useSearchParams();
  const page = pageNumber(params);
  const query = useQuery({
    queryKey: ["events", page],
    queryFn: ({ signal }) => api(`/events?page=${page}`, { signal }),
  });
  return (
    <main id="main-content" className="shell product-page">
      {home ? (
        <section className="discovery-intro">
          <h1>Find your next event.</h1>
          <p>
            Browse published events, compare prices, and get a feel for the
            venue before you go.
          </p>
        </section>
      ) : (
        <h1>Events</h1>
      )}
      <section
        aria-labelledby="discovery-heading"
        className="discovery-results"
      >
        <h2 id="discovery-heading" className={home ? "" : "sr-only"}>
          Published events
        </h2>
        {query.isPending && <Loading>Loading events…</Loading>}
        {query.isError && (
          <Failure error={query.error} retry={() => query.refetch()} />
        )}
        {query.isSuccess && (
          <>
            {query.data.events.length === 0 ? (
              <Empty
                title={
                  page === 1 ? "No published events" : "No events on this page"
                }
              >
                Check back when organizers publish their events.
              </Empty>
            ) : (
              <div className="event-grid">
                {query.data.events.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))}
              </div>
            )}
            <Pagination
              page={page}
              hasNext={query.data.hasNext}
              path={home ? "/" : "/events"}
            />
          </>
        )}
      </section>
    </main>
  );
}

function countdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function SaleInfo({ event, serverTime, receivedAt }) {
  const { user } = useSession();
  const [measured, setMeasured] = useState(receivedAt);
  const left =
    Date.parse(event.saleStartsAt) -
    Date.parse(serverTime) -
    Math.max(0, measured - receivedAt);
  const now = Date.parse(event.saleStartsAt) - left;
  const sale = saleState(event, now);
  const counting = sale === "upcoming";
  const ticking = counting || sale === "open";
  useEffect(() => {
    if (!ticking) return;
    const interval = setInterval(() => setMeasured(performance.now()), 1000);
    return () => clearInterval(interval);
  }, [ticking]);
  return (
    <section className="sale-info" aria-labelledby="sale-heading">
      <h2 id="sale-heading">Sale schedule</h2>
      {counting && (
        <p className="sale-count">
          Scheduled sale starts in{" "}
          <strong aria-hidden="true">{countdown(left)}</strong>
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>Scheduled sale</dt>
          <dd>
            <time dateTime={event.saleStartsAt}>
              {formatDate(event.saleStartsAt, event.timeZone)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Scheduled lobby</dt>
          <dd>
            <time dateTime={event.lobbyOpensAt}>
              {formatDate(event.lobbyOpensAt, event.timeZone)}
            </time>
          </dd>
        </div>
      </dl>
      {sale !== "closed" ? (
        <>
          {sale !== "open" && (
            <p className="support">Booking is unavailable.</p>
          )}
          <Link className="primary-action" to={`/events/${event.id}/queue`}>
            View waiting room
          </Link>
        </>
      ) : (
        <>
          <p className="support">New seat holds are closed.</p>
          {user?.role === "attendee" && (
            <Link to={`/events/${event.id}/book`}>View existing booking</Link>
          )}
        </>
      )}
    </section>
  );
}

export function EventDetail() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ["event", id],
    queryFn: async ({ signal }) => ({
      ...(await api(`/events/${encodeURIComponent(id)}`, { signal })),
      receivedAt: performance.now(),
    }),
  });
  const event = query.data?.event;
  return (
    <main id="main-content" className="shell product-page">
      <Link className="back-link" to="/events">
        Back to events
      </Link>
      {query.isPending && <Loading>Loading event…</Loading>}
      {query.isError && (
        <>
          <h1>
            {query.error.status === 404
              ? "Event unavailable"
              : "Could not load this event"}
          </h1>
          <Failure
            error={query.error}
            retry={
              query.error.status === 404 ? undefined : () => query.refetch()
            }
          />
        </>
      )}
      {query.isSuccess && (
        <>
          <div className="event-detail-intro">
            <EventCover type={event.type} />
            <div>
              <div className="event-labels">
                <span>{templates[event.type].name}</span>
                <span className="status-tag">{statusNames[event.status]}</span>
                {event.isDemo && <span className="status-tag">Demo event</span>}
              </div>
              <h1 className="editorial-heading">{event.title}</h1>
              <p className="event-venue">{event.venue}</p>
              <time dateTime={event.startsAt}>
                {formatDate(event.startsAt, event.timeZone)}
              </time>
              <p className="event-description">{event.description}</p>
            </div>
          </div>
          <div className="detail-grid">
            <section aria-labelledby="layout-heading">
              <h2 id="layout-heading">Seating preview</h2>
              <p className="support">
                {event.totalSeats} seats in the published layout. Availability
                is not shown.
              </p>
              <SeatMap layout={event.layout} currency={event.currency} />
            </section>
            <SaleInfo key={query.data.receivedAt} {...query.data} />
          </div>
        </>
      )}
    </main>
  );
}
