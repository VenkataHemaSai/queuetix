import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { Empty, Failure, Loading, Pagination } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { formatDate, formatPrice, pageNumber } from "../events/presentation.js";
import { AttendeeOnly } from "./BookingPage.jsx";

function TicketQr({ payload }) {
  const [image, setImage] = useState(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(payload, {
      width: 240,
      margin: 4,
      errorCorrectionLevel: "M",
    })
      .then((result) => {
        if (active) setImage(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [payload, retry]);
  if (error)
    return (
      <Failure
        error={{ message: "The QR code could not be displayed." }}
        retry={() => {
          setError(false);
          setRetry(retry + 1);
        }}
      />
    );
  return image ? (
    <img
      src={image}
      width="240"
      height="240"
      alt="Ticket QR code for entry"
      loading="lazy"
    />
  ) : (
    <p className="support">Preparing QR code…</p>
  );
}

function TicketList() {
  const { user, request } = useSession();
  const [params] = useSearchParams();
  const page = pageNumber(params);
  const query = useQuery({
    queryKey: ["booking", user.id, "tickets", page],
    queryFn: ({ signal }) => request(`/tickets/my?page=${page}`, { signal }),
  });
  return (
    <main id="main-content" className="shell product-page">
      <h1>My tickets</h1>
      {query.isPending && <Loading>Loading your tickets…</Loading>}
      {query.isError && (
        <Failure error={query.error} retry={() => query.refetch()} />
      )}
      {query.isSuccess && (
        <>
          {query.data.tickets.length === 0 ? (
            <Empty title="No tickets yet">
              Tickets appear here after a booking is confirmed.
            </Empty>
          ) : (
            <div className="ticket-grid">
              {query.data.tickets.map((ticket) => (
                <article className="booking-card ticket-card" key={ticket.id}>
                  <div className="event-labels">
                    <span className="status-tag">
                      {ticket.status === "used" ? "Used" : "Valid ticket"}
                    </span>
                  </div>
                  <h2>
                    <Link to={`/events/${ticket.event.id}`}>
                      {ticket.event.title}
                    </Link>
                  </h2>
                  <p>{ticket.event.venue}</p>
                  <p className="support">
                    <time dateTime={ticket.event.startsAt}>
                      {formatDate(ticket.event.startsAt, ticket.event.timeZone)}
                    </time>
                  </p>
                  {ticket.status === "used" && ticket.scannedAt && (
                    <p className="support">
                      Checked in{" "}
                      <time dateTime={ticket.scannedAt}>
                        {formatDate(ticket.scannedAt, ticket.event.timeZone)}
                      </time>
                    </p>
                  )}
                  <dl className="facts">
                    <div>
                      <dt>Seat</dt>
                      <dd>
                        {ticket.seat.label} · Section{" "}
                        {ticket.seat.section.toUpperCase()}
                      </dd>
                    </div>
                    <div>
                      <dt>Seat price</dt>
                      <dd>
                        {formatPrice(ticket.seat.price, ticket.order.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt>Order</dt>
                      <dd>
                        <Link to={`/checkout/${ticket.order.id}`}>
                          View confirmed order
                        </Link>
                      </dd>
                    </div>
                  </dl>
                  {ticket.status !== "used" && (
                    <TicketQr
                      key={ticket.qrPayload}
                      payload={ticket.qrPayload}
                    />
                  )}
                </article>
              ))}
            </div>
          )}
          <Pagination
            page={page}
            hasNext={query.data.hasNext}
            path="/tickets"
          />
        </>
      )}
    </main>
  );
}

export function TicketsPage() {
  return (
    <AttendeeOnly>
      <TicketList />
    </AttendeeOnly>
  );
}
