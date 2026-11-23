import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { tierNames } from "../../../../shared/seat-layout.js";
import { api } from "../../lib/api.js";
import { Failure, Loading } from "../../ui.jsx";
import { SessionGate } from "../auth/AuthPages.jsx";
import { useSession } from "../auth/session.jsx";
import { SeatMap } from "../events/SeatMap.jsx";
import { formatPrice } from "../events/presentation.js";
import { formatRemaining, saleState, useServerTime } from "./time.js";
import "./booking.css";

const devTools =
  import.meta.env.DEV && import.meta.env.VITE_DEV_TOOLS === "true";
const canSelect = (seat) => seat && (seat.status === "available" || seat.mine);

export function AttendeeOnly({ children }) {
  const { user } = useSession();
  return (
    <SessionGate>
      {user?.role === "attendee" ? (
        children
      ) : (
        <main id="main-content" className="shell product-page">
          <h1>Attendee access required</h1>
          <p className="notice">
            Sign in with an attendee account to manage bookings.
          </p>
          <Link to="/account">Go to account</Link>
        </main>
      )}
    </SessionGate>
  );
}

function SeatSummary({ seats, currency }) {
  return (
    <ul className="booking-lines">
      {seats.map((seat) => (
        <li key={seat.id ?? seat.seatId}>
          <span>
            {seat.label} · {tierNames[seat.tier]}
          </span>
          <strong>{formatPrice(seat.price, currency)}</strong>
        </li>
      ))}
    </ul>
  );
}

function SuggestionForm({ event, disabled, suggest, suggestions, select }) {
  const [tier, setTier] = useState(Object.keys(event.layout.tierPrices)[0]);
  const limit = event.maxSeatsPerUser ?? 4;
  const [count, setCount] = useState(() => Math.min(2, limit));
  return (
    <section className="booking-card" aria-labelledby="suggestion-heading">
      <h2 id="suggestion-heading">Best available</h2>
      <p className="support">Find adjacent seats in a price tier.</p>
      <form
        className="suggestion-form"
        onSubmit={(submit) => {
          submit.preventDefault();
          suggest(tier, count);
        }}
      >
        <label>
          Price tier
          <select
            value={tier}
            onChange={(change) => setTier(change.target.value)}
          >
            {Object.keys(event.layout.tierPrices).map((value) => (
              <option key={value} value={value}>
                {tierNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Seats
          <select
            value={count}
            onChange={(change) => setCount(Number(change.target.value))}
          >
            {Array.from({ length: limit }, (_, index) => (
              <option key={index} value={index + 1}>
                {index + 1}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary-action" disabled={disabled}>
          Find seats
        </button>
      </form>
      {suggestions && (
        <div className="suggestions">
          <p role="status">
            {suggestions.length
              ? "No full group available. Try a smaller group."
              : "No adjacent seats are available in this tier."}
          </p>
          {suggestions.map((seats) => (
            <button
              className="secondary-action"
              type="button"
              key={seats[0].id}
              onClick={() => select(seats.map(({ id }) => id))}
              disabled={disabled}
            >
              Select {seats.map(({ label }) => label).join(", ")}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Booking() {
  const { id } = useParams();
  const { user, request, connect } = useSession();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const base = `/events/${id}`;
  const [chosen, setChosen] = useState([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [lastHold, setLastHold] = useState(null);
  const [lastPassExpired, setLastPassExpired] = useState(false);
  const [holdCooldown, setHoldCooldown] = useState(0);
  const [seatLive, setSeatLive] = useState(false);
  const active = useRef(false);
  const intent = useRef(null);
  const eventQuery = useQuery({
    queryKey: ["event", id],
    refetchOnMount: "always",
    queryFn: async ({ signal }) => ({
      ...(await api(base, { signal })),
      receivedAt: performance.now(),
    }),
  });
  const booking = useQuery({
    queryKey: ["booking", user.id, id],
    queryFn: async ({ signal }) => ({
      ...(await request(`${base}/booking`, { signal })),
      receivedAt: performance.now(),
    }),
  });
  const state = booking.data;
  const event = eventQuery.data?.event;
  const anchor = state ?? eventQuery.data;
  const now = useServerTime(anchor);
  const pass = state?.pass;
  const hold = state?.hold;
  const holdExpired = Boolean(hold && Date.parse(hold.expiresAt) <= now);
  const passExpired = Boolean(pass && Date.parse(pass.expiresAt) <= now);
  const passActive = Boolean(pass && !passExpired);
  const sale = event ? saleState(event, now) : null;
  const canChoose = Boolean(
    passActive && sale === "open" && (!hold || holdExpired || editing),
  );
  const refreshBooking = booking.refetch;
  useEffect(() => {
    if (holdExpired) setLastHold(hold);
    if (passExpired) setLastPassExpired(true);
    if (holdExpired || passExpired) refreshBooking();
  }, [hold, holdExpired, passExpired, refreshBooking]);
  useEffect(() => {
    if (!holdCooldown) return;
    const timer = setTimeout(() => setHoldCooldown(0), holdCooldown * 1000);
    return () => clearTimeout(timer);
  }, [holdCooldown]);
  const inventory = useQuery({
    queryKey: ["booking", user.id, id, "seats"],
    queryFn: ({ signal }) => request(`${base}/seats`, { signal }),
    enabled: passActive,
    refetchInterval: passActive && !seatLive ? 3000 : false,
  });
  useEffect(() => {
    if (!passActive) return;
    const controller = new AbortController();
    const key = ["booking", user.id, id];
    function endPass(expired) {
      controller.abort();
      setSeatLive(false);
      if (expired) setLastPassExpired(true);
      cache.setQueryData(
        key,
        (previous) => previous && { ...previous, pass: null },
      );
      void refreshBooking();
    }
    void connect("/stream/seats/" + id, {
      signal: controller.signal,
      onDisconnect() {
        setSeatLive(false);
      },
      onMessage(message) {
        if (!message.data) return;
        if (["pass:expired", "order:confirmed"].includes(message.event)) {
          endPass(message.event === "pass:expired");
          return;
        }
        const data = JSON.parse(message.data);
        if (!Array.isArray(data.seats)) return;
        cache.setQueryData([...key, "seats"], { seats: data.seats });
        setSeatLive(true);
      },
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      if (failure.code === "PASS_REQUIRED") endPass(true);
      else setSeatLive(false);
    });
    return () => {
      controller.abort();
      setSeatLive(false);
    };
  }, [passActive, id, user.id, connect, cache, refreshBooking]);
  const limit = state?.maxSeatsPerUser ?? 4;
  const inventoryEmpty = inventory.data?.seats.length === 0;
  const showSelection = canChoose && !inventoryEmpty;
  const inventorySeats = passActive ? (inventory.data?.seats ?? []) : [];
  const selected = inventorySeats.filter(
    (seat) => chosen.includes(seat.id) && canSelect(seat),
  );
  const total = selected.reduce((sum, seat) => sum + seat.price, 0);
  const mapped = Object.fromEntries(
    inventorySeats.map((seat) => [
      seat.seatIndex,
      {
        id: seat.id,
        price: seat.price,
        pickable: canChoose && !busy && canSelect(seat),
        state: selected.some(({ id }) => id === seat.id)
          ? "selected"
          : seat.mine
            ? "mine"
            : seat.status,
      },
    ]),
  );

  function pick(id) {
    setChosen((before) => {
      const usable = before.filter((key) =>
        inventorySeats.some((seat) => seat.id === key && canSelect(seat)),
      );
      if (usable.includes(id)) return usable.filter((seat) => seat !== id);
      return usable.length < limit ? [...usable, id] : usable;
    });
  }

  async function run(action) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
      if (failure.retryAfter) setHoldCooldown(failure.retryAfter);
      if (
        [
          "SEAT_UNAVAILABLE",
          "PASS_REQUIRED",
          "HOLD_EXPIRED",
          "HOLD_EXISTS",
          "TXN_COMMIT_UNCONFIRMED",
        ].includes(failure.code)
      ) {
        await Promise.all([
          refreshBooking(),
          passActive && inventory.refetch(),
        ]);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function saveHold() {
    const seatIds = selected.map(({ id }) => id).sort();
    const fingerprint = seatIds.join(",");
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, key: crypto.randomUUID() };
    const replace = hold && !holdExpired;
    const result = await request(`${base}/holds${replace ? "/current" : ""}`, {
      method: replace ? "PUT" : "POST",
      body: replace
        ? { holdId: hold.id, seatIds }
        : { seatIds, idempotencyKey: intent.current.key },
    });
    setLastHold(result.hold.status === "active" ? result.hold : null);
    intent.current = null;
    setEditing(false);
    setChosen([]);
    await Promise.all([refreshBooking(), inventory.refetch()]);
  }

  async function release() {
    await request(`${base}/holds/current`, {
      method: "DELETE",
      body: { holdId: hold.id },
    });
    setLastHold(null);
    setEditing(false);
    setChosen([]);
    await Promise.all([refreshBooking(), passActive && inventory.refetch()]);
  }

  async function checkout() {
    const { order } = await request("/orders", {
      method: "POST",
      body: {
        eventId: id,
        holdId: hold.id,
        idempotencyKey: `checkout:${hold.id}`,
      },
    });
    navigate(`/checkout/${order.id}`);
  }

  async function suggest(tier, count) {
    const result = await request(
      `${base}/best-available?${new URLSearchParams({ tier, count })}`,
    );
    setSuggestions(result.seats.length ? null : result.alternatives);
    if (result.seats.length) setChosen(result.seats.map(({ id }) => id));
  }

  if (!event || !state) {
    const failure = eventQuery.error ?? booking.error;
    return (
      <main id="main-content" className="shell product-page">
        <h1>Book seats</h1>
        {failure ? (
          <Failure
            error={failure}
            retry={() => {
              eventQuery.refetch();
              refreshBooking();
            }}
          />
        ) : (
          <Loading>Loading booking details…</Loading>
        )}
      </main>
    );
  }
  const liveHold = hold && !holdExpired;
  const order = state.order;
  const holdTotal = liveHold
    ? hold.seats.reduce((sum, seat) => sum + seat.price, 0)
    : 0;
  const recentlyExpired =
    holdExpired || (lastHold && !hold && Date.parse(lastHold.expiresAt) <= now);
  const labels = error?.fields?.labels;
  return (
    <main
      id="main-content"
      className={`shell product-page${canChoose && selected.length ? " page-with-selection" : ""}`}
    >
      <Link className="back-link" to={base}>
        Back to event
      </Link>
      <h1>{event.title}</h1>
      <p className="support">
        {event.venue}
        {event.isDemo ? " · Demo event" : ""}
      </p>
      {error && (
        <Failure
          error={
            labels?.length
              ? {
                  message: `Seat ${labels.join(", ")} is unavailable. Review your remaining selection.`,
                }
              : error
          }
        />
      )}
      {booking.isError && (
        <Failure error={booking.error} retry={refreshBooking} />
      )}
      {recentlyExpired && (
        <p className="notice" role="status">
          Your hold expired. Seats may now be claimed by other attendees.
        </p>
      )}
      {!passActive && (
        <p className="notice" role="status">
          {passExpired || lastPassExpired
            ? "Your admission pass expired."
            : "No active admission pass."}
          {liveHold ? " Your current hold is still valid." : ""}
        </p>
      )}
      {!passActive && sale !== "closed" && order?.status !== "paid" && (
        <Link to={base + "/queue"}>Open waiting room</Link>
      )}
      {sale !== "open" && (
        <p className="notice" role="status">
          {sale === "closed"
            ? "New seat holds are closed."
            : "Seat selection has not opened."}
        </p>
      )}
      {devTools &&
        !passActive &&
        sale === "open" &&
        order?.status !== "paid" && (
          <details className="booking-dev">
            <summary>Development tools</summary>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await request("/dev/issue-pass", {
                    method: "POST",
                    body: { eventId: id },
                  });
                  await refreshBooking();
                })
              }
            >
              Admit me
            </button>
          </details>
        )}
      <div className="detail-grid booking-grid">
        {passActive && (
          <section aria-labelledby="booking-layout">
            <h2 id="booking-layout">
              {editing ? "Change seats" : "Choose seats"}
            </h2>
            <p className="support">
              Choose up to {limit} seats.{" "}
              {seatLive
                ? "Availability updates live."
                : "Availability refreshes every three seconds while your pass is active."}
            </p>
            {inventory.isPending && <Loading>Loading seats…</Loading>}
            {(inventory.isError || inventoryEmpty) && (
              <Failure
                error={
                  inventory.error ?? {
                    message: "Seat inventory is unavailable for this event.",
                  }
                }
                retry={() => inventory.refetch()}
              />
            )}
            {inventory.data && !inventoryEmpty && (
              <SeatMap
                layout={event.layout}
                currency={event.currency}
                seatState={mapped}
                onPick={canChoose ? pick : undefined}
              />
            )}
          </section>
        )}
        <aside className="booking-sidebar" aria-label="Booking summary">
          {showSelection && (
            <SuggestionForm
              event={{ ...event, maxSeatsPerUser: limit }}
              disabled={busy}
              suggest={(tier, count) => run(() => suggest(tier, count))}
              suggestions={suggestions}
              select={setChosen}
            />
          )}
          {showSelection && (
            <section
              className="booking-card"
              id="booking-selection"
              tabIndex={-1}
            >
              <h2>{editing ? "Replacement seats" : "Your selection"}</h2>
              {selected.length ? (
                <SeatSummary seats={selected} currency={event.currency} />
              ) : (
                <p className="support">
                  Select seats on the map or use Best available.
                </p>
              )}
              {chosen.length > selected.length && (
                <p className="support" role="status">
                  Some selections became unavailable.
                </p>
              )}
              <p className="booking-total">
                <span>Total</span>
                <strong>{formatPrice(total, event.currency)}</strong>
              </p>
              <p className="sr-only" role="status">
                {selected.length} seats selected. Total{" "}
                {formatPrice(total, event.currency)}.
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || holdCooldown > 0 || !selected.length}
                  onClick={() => run(saveHold)}
                >
                  {editing ? "Save new selection" : "Hold seats"}
                </button>
                {editing && (
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setChosen([]);
                    }}
                  >
                    Cancel changes
                  </button>
                )}
              </div>
            </section>
          )}
          {liveHold && (
            <section className="booking-card hold-card">
              <h2>Seats held for you</h2>
              <SeatSummary seats={hold.seats} currency={event.currency} />
              <p className="booking-total">
                <span>Total</span>
                <strong>{formatPrice(holdTotal, event.currency)}</strong>
              </p>
              <p className="booking-timer">
                <strong aria-hidden="true">
                  {formatRemaining(Date.parse(hold.expiresAt) - now)}
                </strong>{" "}
                remaining
              </p>
              <p className="support">
                Hold ends at{" "}
                <time dateTime={hold.expiresAt}>
                  {new Date(hold.expiresAt).toLocaleTimeString()}
                </time>
                .
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || editing}
                  onClick={() => run(checkout)}
                >
                  Continue to checkout
                </button>
                {passActive && sale === "open" && !editing && (
                  <button
                    type="button"
                    disabled={busy}
                    className="secondary-action"
                    onClick={() => {
                      setChosen(hold.seatIds);
                      setEditing(true);
                    }}
                  >
                    Change seats
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || holdCooldown > 0}
                  className="secondary-action"
                  onClick={() => run(release)}
                >
                  Release seats
                </button>
              </div>
            </section>
          )}
          {!liveHold && order && (
            <section className="booking-card">
              <h2>Latest order</h2>
              <p>
                {order.status === "paid"
                  ? "Booking confirmed"
                  : order.status === "failed"
                    ? "Payment closed"
                    : "Payment pending"}
              </p>
              <Link to={`/checkout/${order.id}`}>View order</Link>
            </section>
          )}
        </aside>
      </div>
      {canChoose && selected.length > 0 && (
        <div className="mobile-booking-summary">
          <span>
            {selected.length} selected ·{" "}
            <strong>{formatPrice(total, event.currency)}</strong>
          </span>
          <a className="primary-action" href="#booking-selection">
            Review seats
          </a>
        </div>
      )}
    </main>
  );
}

export function BookingPage() {
  const { id } = useParams();
  return (
    <AttendeeOnly>
      <Booking key={id} />
    </AttendeeOnly>
  );
}
