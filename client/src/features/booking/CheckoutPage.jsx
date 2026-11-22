import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { tierNames } from "../../../../shared/seat-layout.js";
import { Failure, Loading } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { formatPrice } from "../events/presentation.js";
import { AttendeeOnly } from "./BookingPage.jsx";
import { formatRemaining, useServerTime } from "./time.js";

const failureReasons = {
  seats_unavailable:
    "The seats were no longer available when the payment arrived.",
  superseded: "A newer hold replaced this checkout.",
  event_ended: "The event ended before payment was confirmed.",
  payment_failed: "The mock payment failed.",
  hold_released: "The seats were released before payment was confirmed.",
};

function Checkout() {
  const { id } = useParams();
  const { user, request } = useSession();
  const cache = useQueryClient();
  const key = ["booking", user.id, "order", id];
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const result = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => ({
      ...(await request(`/orders/${id}`, { signal })),
      receivedAt: performance.now(),
    }),
    refetchInterval: (query) =>
      reconciling && query.state.data?.order.status === "pending"
        ? 3000
        : false,
  });
  const data = result.data;
  const order = data?.order;
  const now = useServerTime(
    data,
    order?.status === "pending" && data?.holdActive,
  );
  const pending = order?.status === "pending";
  const left = order ? Date.parse(order.holdExpiresAt) - now : 0;
  const canPay = pending && data.holdActive && left > 0;
  useEffect(() => {
    if (!reconciling || !pending) return;
    const timer = setTimeout(() => setReconciling(false), 15_000);
    return () => clearTimeout(timer);
  }, [pending, reconciling]);

  async function pay(outcome) {
    if (!canPay || active.current || reconciling) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await request(`/orders/${id}/mock`, {
        method: "POST",
        body: { outcome },
      });
      await cache.cancelQueries({ queryKey: key, exact: true });
      cache.setQueryData(key, (previous) => ({ ...previous, ...confirmed }));
      cache.invalidateQueries({
        queryKey: ["booking", user.id],
        predicate: (query) => query.queryKey[2] !== "order",
      });
    } catch (failure) {
      const current = await result.refetch();
      if (current.data?.order.status === "pending") {
        if (failure.status === 503 || failure.code === "IDEMPOTENCY_CONFLICT")
          setReconciling(true);
        setError(failure);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  if (!order)
    return (
      <main id="main-content" className="shell product-page">
        <h1>Checkout</h1>
        {result.isError ? (
          <Failure error={result.error} retry={() => result.refetch()} />
        ) : (
          <Loading>Loading order…</Loading>
        )}
      </main>
    );
  return (
    <main id="main-content" className="shell product-page">
      <Link to={`/events/${order.eventId}/book`} className="back-link">
        Back to seats
      </Link>
      <div className="checkout-shell">
        <h1>{order.status === "paid" ? "Booking confirmed" : "Checkout"}</h1>
        <p className="support">Demo payment. No real money is charged.</p>
        <section className="booking-card" aria-labelledby="order-summary">
          <h2 id="order-summary">Order summary</h2>
          <ul className="booking-lines">
            {order.seats.map((seat) => (
              <li key={seat.seatId}>
                <span>
                  {seat.label} · {tierNames[seat.tier]}
                </span>
                <strong>{formatPrice(seat.price, order.currency)}</strong>
              </li>
            ))}
          </ul>
          <p className="booking-total">
            <span>Total</span>
            <strong>{formatPrice(order.amount, order.currency)}</strong>
          </p>
          {order.status === "paid" && (
            <>
              <p role="status">Your tickets are ready.</p>
              <Link className="primary-action" to="/tickets">
                View my tickets
              </Link>
            </>
          )}
          {order.status === "failed" && (
            <div className="notice notice-error" role="status">
              <p>
                {data.payment?.status === "refunded"
                  ? "Mock payment refunded"
                  : "Payment failed"}
              </p>
              <p>
                {failureReasons[order.failureReason] ??
                  "This checkout is closed."}
              </p>
            </div>
          )}
          {data.payment?.status === "refunded" && order.status === "paid" && (
            <p className="support">
              An extra mock payment was refunded. Your booking is confirmed.
            </p>
          )}
          {pending && (
            <>
              <p role={canPay ? undefined : "status"}>
                {canPay
                  ? "Payment pending."
                  : "This hold ended. A pending payment can still be confirmed by the server."}
              </p>
              {canPay && (
                <p className="booking-timer">
                  <strong aria-hidden="true">{formatRemaining(left)}</strong>{" "}
                  remaining
                </p>
              )}
              <div className="actions">
                {canPay && !reconciling && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => pay("succeeded")}
                    >
                      Pay
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={busy}
                      onClick={() => pay("failed")}
                    >
                      Fail payment
                    </button>
                  </>
                )}
                {(!canPay || reconciling) && (
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={busy || result.isFetching}
                    onClick={() => result.refetch()}
                  >
                    Check booking status
                  </button>
                )}
              </div>
              {(busy || reconciling) && (
                <p role="status">Checking booking status…</p>
              )}
              {error && <Failure error={error} />}
              {result.isError && (
                <Failure error={result.error} retry={() => result.refetch()} />
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export function CheckoutPage() {
  const { id } = useParams();
  return (
    <AttendeeOnly>
      <Checkout key={id} />
    </AttendeeOnly>
  );
}
