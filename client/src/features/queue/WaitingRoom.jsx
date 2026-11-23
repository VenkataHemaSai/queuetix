import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api.js";
import { Failure, Loading } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { AttendeeOnly } from "../booking/BookingPage.jsx";
import { formatRemaining, useServerTime } from "../booking/time.js";
import { formatDate } from "../events/presentation.js";
import "./queue.css";

const subtitles = {
  scheduled: "The waiting room opens before the sale.",
  lobby_open:
    "Everyone who joins before the sale opens has the same chance in the draw.",
  opening:
    "We’re assigning queue numbers to the frozen lobby. Stay on this page.",
};
const rejoinReasons = {
  REJOIN_LIMIT: "You have already used your one rejoin for this event.",
  NO_STOCK: "Rejoin will be available if seats return.",
  SALE_CLOSED: "New sale participation has closed.",
};
const announcements = {
  lobby: "You’re in the lobby.",
  waiting: "You’re in the numbered queue.",
  admitted: "You’re admitted.",
  abandoned: "You were removed from the queue.",
  expired: "Your admission pass expired.",
  expired_soldout: "Sold out.",
  completed: "Booking confirmed.",
};
const timed = (state) => ({ ...state, receivedAt: performance.now() });

function latestQueueState(previous, next) {
  if (Date.parse(previous?.serverTime) > Date.parse(next.serverTime))
    return previous;
  if (
    previous?.entry?.status === "waiting" &&
    next.entry?.status === "waiting" &&
    previous.entry.number === next.entry.number &&
    Number.isFinite(previous.approximatePosition) &&
    next.approximatePosition > previous.approximatePosition
  )
    return previous;
  return next;
}

function useWaitingRoom(id) {
  const { user, request, connect } = useSession();
  const [connection, setConnection] = useState("connecting");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const intent = useRef(null);
  const action = useRef(null);
  const cache = useQueryClient();
  const key = ["booking", user.id, id, "queue"];
  const base = "/events/" + id + "/queue";
  const query = useQuery({
    queryKey: key,
    structuralSharing: latestQueueState,
    queryFn: async ({ signal }) =>
      timed(await request(base + "/me", { signal })),
  });
  useEffect(() => {
    const controller = new AbortController();
    const queryKey = ["booking", user.id, id, "queue"];
    let transport = false;
    let pinging = false;
    const disconnected = () => setConnection("reconnecting");
    void connect("/stream/queue/" + id, {
      signal: controller.signal,
      onOpen() {
        transport = true;
        setConnection("connected");
      },
      onDisconnect() {
        transport = false;
        disconnected();
      },
      onMessage(message) {
        if (!message.data) return;
        const next = timed(JSON.parse(message.data));
        cache.setQueryData(queryKey, next);
      },
    }).catch(() => {
      if (!controller.signal.aborted) disconnected();
    });
    async function ping() {
      if (pinging) return;
      pinging = true;
      try {
        await request(base + "/ping", {
          method: "POST",
          signal: controller.signal,
        });
        if (!controller.signal.aborted && transport) setConnection("connected");
      } catch {
        if (!controller.signal.aborted) disconnected();
      } finally {
        pinging = false;
      }
    }
    const packet = setInterval(ping, 15_000);
    window.addEventListener("offline", disconnected);
    window.addEventListener("online", ping);
    return () => {
      controller.abort();
      clearInterval(packet);
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("online", ping);
    };
  }, [id, user.id, base, request, connect, cache]);
  useEffect(
    () => () => {
      action.current?.controller.abort();
      clearTimeout(action.current?.timer);
    },
    [],
  );

  function submit(rejoin) {
    if (action.current) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    action.current = { controller };
    if (rejoin) intent.current ??= "rejoin:" + query.data.entry.number;
    async function attempt() {
      try {
        await request(base + (rejoin ? "/rejoin" : "/join"), {
          method: "POST",
          signal: controller.signal,
          ...(rejoin && { body: { idempotencyKey: intent.current } }),
        });
        await query.refetch();
        if (rejoin) intent.current = null;
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 429 && failure.retryAfter > 0) {
          setOpening(false);
          setError(failure);
          action.current.timer = setTimeout(() => {
            action.current = null;
            setBusy(false);
          }, failure.retryAfter * 1000);
          return;
        }
        if (failure.code === "SALE_OPENING") {
          setOpening(true);
          action.current.timer = setTimeout(
            attempt,
            failure.fields?.retryAfterMs ?? 1500,
          );
          return;
        }
        setError(failure);
      }
      if (!controller.signal.aborted) {
        action.current = null;
        setBusy(false);
        setOpening(false);
      }
    }
    void attempt();
  }
  return { query, connection, submit, busy, opening, error };
}

function Placement({ state }) {
  return (
    <>
      <h2 className="queue-position">About #{state.approximatePosition}</h2>
      <p className="support">Your position is approximate.</p>
      <dl className="queue-metrics">
        <div>
          <dt>Seats available</dt>
          <dd>{state.seatsRemaining ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Estimated wait</dt>
          <dd>
            {state.etaMinutes == null
              ? "Calculating wait time..."
              : "About " +
                state.etaMinutes +
                (state.etaMinutes === 1 ? " minute" : " minutes")}
          </dd>
        </div>
      </dl>
      {state.seatsRemaining === 0 && state.hasActiveHolds ? (
        <p className="notice">
          Almost gone. Seats may return if holds expire or payments fail.
        </p>
      ) : (
        state.seatsRemaining !== null &&
        state.seatsRemaining < state.approximatePosition && (
          <p className="notice">
            Low chance. Tickets may sell out before your turn.
          </p>
        )
      )}
    </>
  );
}

function QueueStatus({ state, event, now, submit, busy, opening, id }) {
  const booking = "/events/" + id + "/book";
  const phase = state.eventStatus;
  const status = state.entry?.status;
  if (status === "completed" || state.order?.status === "paid")
    return (
      <>
        <h2>Booking confirmed</h2>
        <Link className="primary-action" to="/tickets">
          View my tickets
        </Link>
      </>
    );
  if (state.saleClosed || now >= Date.parse(state.startsAt))
    return (
      <>
        <h2>{phase === "sold_out" ? "Sold out" : "Sale closed"}</h2>
        {state.hold && (
          <Link className="primary-action" to={booking}>
            View held seats
          </Link>
        )}
        {!state.hold && state.order && (
          <Link to={"/checkout/" + state.order.id}>View existing order</Link>
        )}
      </>
    );
  if (state.pass && Date.parse(state.pass.expiresAt) > now)
    return (
      <>
        <h2>You’re admitted</h2>
        <p className="queue-clock" aria-hidden="true">
          {formatRemaining(Date.parse(state.pass.expiresAt) - now)}
        </p>
        <p className="support">
          Admission expires at{" "}
          <time dateTime={state.pass.expiresAt}>
            {formatDate(state.pass.expiresAt, event.timeZone)}
          </time>
          .
        </p>
        <Link className="primary-action" to={booking}>
          Choose seats
        </Link>
      </>
    );
  if (opening || phase === "opening")
    return (
      <>
        <h2>The sale is opening</h2>
        <p>{subtitles.opening}</p>
      </>
    );
  if (status === "waiting" && state.approximatePosition !== null)
    return <Placement state={state} />;
  if (status === "admitted")
    return (
      <>
        <h2>Checking admission</h2>
        <p>Waiting for the server to confirm your pass status.</p>
      </>
    );
  if (
    status === "expired" ||
    status === "abandoned" ||
    status === "expired_soldout"
  )
    return (
      <>
        <h2>
          {status === "expired"
            ? "Your admission pass expired"
            : status === "abandoned"
              ? "You were removed from the queue"
              : "Sold out"}
        </h2>
        {status === "abandoned" && (
          <p>We lost your connection to the waiting room.</p>
        )}
        {state.canRejoin ? (
          <button type="button" disabled={busy} onClick={() => submit(true)}>
            Rejoin queue
          </button>
        ) : (
          <p className="support">
            {rejoinReasons[state.rejoinReason] ?? "Rejoin is unavailable."}
          </p>
        )}
        {state.hold && <Link to={booking}>View held seats</Link>}
        {!state.hold && state.order && (
          <Link to={"/checkout/" + state.order.id}>View existing order</Link>
        )}
      </>
    );
  if (status === "lobby")
    return (
      <>
        <h2>You’re in the lobby</h2>
        <p>{subtitles.lobby_open}</p>
      </>
    );
  if (state.seatsRemaining === null)
    return (
      <>
        <h2>Waiting room unavailable</h2>
        <p>Seat inventory could not be verified.</p>
      </>
    );
  if (phase === "scheduled")
    return (
      <>
        <h2>Waiting room opens soon</h2>
        <p>{subtitles.scheduled}</p>
        <p className="support">
          <time dateTime={state.lobbyOpensAt}>
            {formatDate(state.lobbyOpensAt, event.timeZone)}
          </time>
        </p>
      </>
    );
  return (
    <>
      <h2>
        {phase === "lobby_open" ? "The lobby is open" : "The sale is open"}
      </h2>
      {phase === "lobby_open" && <p>{subtitles.lobby_open}</p>}
      <button type="button" disabled={busy} onClick={() => submit(false)}>
        Join waiting room
      </button>
    </>
  );
}

function QueueScreen({ id }) {
  const { query, connection, submit, busy, opening, error } =
    useWaitingRoom(id);
  const eventQuery = useQuery({
    queryKey: ["event", id],
    queryFn: async ({ signal }) =>
      timed(await api("/events/" + id, { signal })),
  });
  const state = query.data;
  const event = eventQuery.data?.event;
  const now = useServerTime(state);
  const failure = query.error ?? eventQuery.error;
  const connectionLabel = {
    connecting: "Connecting to the ticket service…",
    connected: "Connected",
    reconnecting: "Reconnecting",
  };
  return (
    <main id="main-content" className="shell product-page queue-page">
      <Link className="back-link" to={"/events/" + id}>
        Back to event
      </Link>
      <h1>{event?.title ?? "Waiting room"}</h1>
      {event?.isDemo && <p className="support">Demo event</p>}
      <section className="queue-panel" aria-label="Waiting room">
        <p className="sr-only" role="status">
          {state?.entry?.status === "completed" ||
          state?.order?.status === "paid"
            ? announcements.completed
            : state?.eventStatus === "sold_out"
              ? "Sold out."
              : state?.saleClosed
                ? "Sale closed."
                : announcements[state?.entry?.status]}
        </p>
        {state && (
          <p className="queue-connection" role="status">
            {connectionLabel[connection]}
          </p>
        )}
        {failure && (
          <Failure
            error={failure}
            retry={() => {
              query.refetch();
              eventQuery.refetch();
            }}
          />
        )}
        {error && <Failure error={error} />}
        {state && event ? (
          <QueueStatus {...{ state, event, now, submit, busy, opening, id }} />
        ) : (
          !failure && <Loading>Loading waiting room…</Loading>
        )}
      </section>
    </main>
  );
}

export function WaitingRoom() {
  const { id } = useParams();
  return (
    <AttendeeOnly>
      <QueueScreen key={id} id={id} />
    </AttendeeOnly>
  );
}
