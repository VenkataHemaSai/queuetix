import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { tierNames } from "../../../../shared/seat-layout.js";
import { Failure, Loading } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { formatPrice } from "../events/presentation.js";
import { AttendeeOnly } from "./BookingPage.jsx";
import { openRazorpay } from "./razorpay.js";
import { formatRemaining, useServerTime } from "./time.js";

const failureReasons = {
  seats_unavailable:
    "The seats were no longer available when the payment arrived.",
  superseded: "A newer hold replaced this checkout.",
  event_ended: "The event ended before payment was confirmed.",
  payment_failed: "The mock payment failed.",
  hold_released: "The seats were released before payment was confirmed.",
};
const refundCopy = {
  requested:
    "A test refund has been requested. Razorpay has yet to confirm it.",
  unknown: "The test refund is still being verified.",
  pending: "Razorpay is processing the test refund.",
  processed: "Razorpay processed the test refund.",
  failed: "Razorpay reported that the test refund failed.",
};

function Checkout() {
  const { id } = useParams();
  const { user, request } = useSession();
  const cache = useQueryClient();
  const key = ["booking", user.id, "order", id];
  const active = useRef(false);
  const gatewayAction = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [gatewayNotice, setGatewayNotice] = useState(null);
  const result = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => ({
      ...(await request(`/orders/${id}`, { signal })),
      receivedAt: performance.now(),
    }),
    refetchInterval: (query) => {
      const current = query.state.data;
      if (
        current?.provider === "razorpay" &&
        ((current.order.status === "pending" && current.payment?.hasAttempt) ||
          ["requested", "unknown", "pending"].includes(
            current.payment?.refund?.status,
          ))
      )
        return 5000;
      return reconciling && current?.order.status === "pending" ? 3000 : false;
    },
  });
  const data = result.data;
  const order = data?.order;
  const razorpay = data?.provider === "razorpay";
  const now = useServerTime(
    data,
    order?.status === "pending" && data?.holdActive,
  );
  const pending = order?.status === "pending";
  const left = order ? Date.parse(order.holdExpiresAt) - now : 0;
  const canPay =
    pending &&
    data.holdActive &&
    left > 0 &&
    (!razorpay || data.gatewayEnabled);
  useEffect(() => () => gatewayAction.current?.abort(), []);
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

  async function payWithRazorpay() {
    if (!canPay || active.current || reconciling) return;
    const controller = new AbortController();
    const { signal } = controller;
    gatewayAction.current = controller;
    active.current = true;
    setBusy(true);
    setError(null);
    setGatewayNotice(null);
    try {
      const { checkout } = await request(`/orders/${id}/razorpay`, {
        method: "POST",
        signal,
      });
      const response = await openRazorpay(checkout, {
        signal,
        onFailure: () =>
          setGatewayNotice(
            "The test attempt failed. You can retry while checkout is open.",
          ),
      });
      if (response) {
        setGatewayNotice(null);
        setReconciling(true);
        await request(`/orders/${id}/razorpay/verify`, {
          method: "POST",
          body: {
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          },
          signal,
        });
      } else {
        setGatewayNotice(
          "Checkout closed. If you submitted a payment, check booking status.",
        );
      }
    } catch (failure) {
      if (signal.aborted) return;
      setReconciling(true);
      setError(failure);
    } finally {
      if (!signal.aborted) {
        const current = await result.refetch();
        if (current.data?.order.status === "paid") {
          void cache.invalidateQueries({
            queryKey: ["booking", user.id],
            predicate: (query) => query.queryKey[2] !== "order",
          });
        }
        active.current = false;
        gatewayAction.current = null;
        setBusy(false);
      }
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
        <p className="support">
          {razorpay
            ? "Razorpay Test Mode. No real money is charged."
            : "Demo payment. No real money is charged."}
        </p>
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
                {razorpay
                  ? "Booking could not be confirmed"
                  : data.payment?.status === "refunded"
                    ? "Mock payment refunded"
                    : "Payment failed"}
              </p>
              <p>
                {failureReasons[order.failureReason] ??
                  "This checkout is closed."}
              </p>
            </div>
          )}
          {!razorpay &&
            data.payment?.status === "refunded" &&
            order.status === "paid" && (
              <p className="support">
                An extra mock payment was refunded. Your booking is confirmed.
              </p>
            )}
          {razorpay && data.payment?.refund && (
            <p className="notice" role="status">
              {refundCopy[data.payment.refund.status]}
            </p>
          )}
          {pending && (
            <>
              <p role={canPay ? undefined : "status"}>
                {razorpay && !data.gatewayEnabled
                  ? "Razorpay Test Mode is unavailable. Check booking status."
                  : canPay
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
                {canPay &&
                  !reconciling &&
                  (razorpay ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={payWithRazorpay}
                    >
                      Pay with Razorpay Test Mode
                    </button>
                  ) : (
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
                  ))}
                {(razorpay || !canPay || reconciling) && (
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
              {gatewayNotice && (
                <p className="notice" role="status">
                  {gatewayNotice}
                </p>
              )}
              {razorpay &&
                !gatewayNotice &&
                !reconciling &&
                data.payment?.gatewayStatus === "failed" && (
                  <p className="notice" role="status">
                    A test payment attempt failed. You can retry while the hold
                    is active.
                  </p>
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
