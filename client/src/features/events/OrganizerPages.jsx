import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  buildLayout,
  templates,
  tierNames,
} from "../../../../shared/seat-layout.js";
import { Empty, Failure, Loading, Pagination } from "../../ui.jsx";
import { OrganizerOnly } from "../auth/AuthPages.jsx";
import { useSession } from "../auth/session.jsx";
import { SeatMap } from "./SeatMap.jsx";
import {
  currencyDigits,
  formatDate,
  pageNumber,
  statusNames,
} from "./presentation.js";

const settings = [
  ["maxActive", "Active checkout limit", 10, 1, 500],
  ["overAdmitBuffer", "Admission buffer", 2, 0, 500],
  ["maxSeatsPerUser", "Seats per attendee", 4, 1, 4],
  ["holdSeconds", "Hold duration (seconds)", 300, 30, 1800],
  ["passSeconds", "Pass duration (seconds)", 600, 60, 3600],
];

function localDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function toMinor(value, currency) {
  const digits = currencyDigits(currency);
  const match = /^\d+(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[1]?.length ?? 0) > digits) return null;
  const [major, fraction = ""] = value.trim().split(".");
  const amount =
    Number(major) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(amount) && amount <= 100_000_000 ? amount : null;
}

function OwnedList() {
  const { user, request } = useSession();
  const [params] = useSearchParams();
  const page = pageNumber(params);
  const list = useQuery({
    queryKey: ["organizer", user.id, "events", page],
    queryFn: ({ signal }) =>
      request(`/organizer/events?page=${page}`, { signal }),
  });
  return (
    <main id="main-content" className="shell product-page">
      <div className="page-top">
        <h1>Your events</h1>
        <Link className="primary-action" to="/organizer/events/new">
          Create event
        </Link>
      </div>
      {list.isPending && <Loading>Loading your events…</Loading>}
      {list.isError && (
        <Failure error={list.error} retry={() => list.refetch()} />
      )}
      {list.isSuccess && (
        <>
          {list.data.events.length === 0 ? (
            <Empty title="No events yet">
              Create a draft to set your event details and seating.
            </Empty>
          ) : (
            <ul className="owned-list">
              {list.data.events.map((event) => (
                <li key={event.id}>
                  <div>
                    <Link to={`/organizer/events/${event.id}`}>
                      {event.title}
                    </Link>
                    <p className="support">
                      {formatDate(event.startsAt, event.timeZone)}
                    </p>
                  </div>
                  <div className="event-labels">
                    <span className="status-tag">
                      {statusNames[event.status]}
                    </span>
                    {event.isDemo && (
                      <span className="status-tag">Demo event</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Pagination
            page={page}
            hasNext={list.data.hasNext}
            path="/organizer/events"
          />
        </>
      )}
    </main>
  );
}

function Field({ label, name, fields, children }) {
  const error = fields?.[name];
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children({
        id: name,
        name,
        "aria-describedby": error ? `${name}-error` : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {error && (
        <small className="field-error" id={`${name}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

function EventForm({ event, reload, onChange, onSaved, publishing }) {
  const { request, user } = useSession();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [type, setType] = useState(event?.type ?? "cinema");
  const [currency, setCurrency] = useState(event?.currency ?? "INR");
  const [prices, setPrices] = useState(() =>
    Object.fromEntries(
      Object.entries(event?.tierPrices ?? {}).map(([tier, value]) => [
        tier,
        String(value / 10 ** currencyDigits(event.currency)),
      ]),
    ),
  );
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const tiers = templates[type].tiers;
  const validCurrency = /^[A-Z]{3}$/.test(currency);
  const tierPrices = validCurrency
    ? Object.fromEntries(
        tiers.map((tier) => [tier, toMinor(prices[tier] ?? "", currency)]),
      )
    : {};
  const validPrices =
    validCurrency && tiers.every((tier) => tierPrices[tier] !== null);

  async function save(submit) {
    submit.preventDefault();
    if (busy) return;
    const form = new FormData(submit.currentTarget);
    if (!validPrices) {
      setError({
        message: "Check prices for the selected currency.",
        fields: Object.fromEntries(
          tiers
            .filter((tier) => tierPrices[tier] == null)
            .map((tier) => [
              `tierPrices.${tier}`,
              "Enter a valid amount for this tier.",
            ]),
        ),
      });
      return;
    }
    const startsAt = new Date(form.get("startsAt"));
    const saleStartsAt = new Date(form.get("saleStartsAt"));
    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(saleStartsAt.getTime())
    ) {
      setError({ message: "Enter valid schedule dates." });
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { event: saved } = await request(
        event ? `/organizer/events/${event.id}` : "/organizer/events",
        {
          method: event ? "PATCH" : "POST",
          body: {
            title: form.get("title"),
            venue: form.get("venue"),
            description: form.get("description"),
            type,
            currency,
            tierPrices,
            timeZone: form.get("timeZone"),
            startsAt: startsAt.toISOString(),
            saleStartsAt: saleStartsAt.toISOString(),
            isDemo: form.has("isDemo"),
            ...Object.fromEntries(
              settings.map(([name]) => [name, Number(form.get(name))]),
            ),
            ...(event && { revision: event.revision }),
          },
        },
      );
      cache.setQueryData(["organizer", user.id, "event", saved.id], {
        event: saved,
      });
      cache.invalidateQueries({ queryKey: ["organizer", user.id, "events"] });
      onSaved();
      if (!event) navigate(`/organizer/events/${saved.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const fields = error?.fields;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <form className="event-form" onSubmit={save} onChange={onChange}>
      {error && (
        <Failure
          error={error}
          retry={error.code === "EVENT_CHANGED" ? reload : undefined}
        />
      )}
      <fieldset disabled={busy || publishing}>
        <legend>Event details</legend>
        <Field label="Title" name="title" fields={fields}>
          {(props) => (
            <input
              {...props}
              defaultValue={event?.title}
              required
              maxLength={120}
            />
          )}
        </Field>
        <Field label="Venue" name="venue" fields={fields}>
          {(props) => (
            <input
              {...props}
              defaultValue={event?.venue}
              required
              maxLength={160}
            />
          )}
        </Field>
        <Field label="Description" name="description" fields={fields}>
          {(props) => (
            <textarea
              {...props}
              defaultValue={event?.description}
              required
              rows={4}
              maxLength={3000}
            />
          )}
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            name="isDemo"
            defaultChecked={event?.isDemo ?? false}
          />{" "}
          Label as a demo event
        </label>
      </fieldset>
      <fieldset disabled={busy || publishing}>
        <legend>Schedule</legend>
        <p className="support">
          Enter times in your device time zone ({deviceZone}). Public dates use
          the event time zone. The lobby is scheduled 10 minutes before the
          sale.
        </p>
        <div className="form-pair">
          <Field label="Event starts" name="startsAt" fields={fields}>
            {(props) => (
              <input
                {...props}
                type="datetime-local"
                defaultValue={localDate(event?.startsAt)}
                required
              />
            )}
          </Field>
          <Field label="Sale starts" name="saleStartsAt" fields={fields}>
            {(props) => (
              <input
                {...props}
                type="datetime-local"
                defaultValue={localDate(event?.saleStartsAt)}
                required
              />
            )}
          </Field>
        </div>
        <Field label="Event time zone" name="timeZone" fields={fields}>
          {(props) => (
            <input
              {...props}
              defaultValue={event?.timeZone ?? deviceZone}
              required
              maxLength={100}
            />
          )}
        </Field>
      </fieldset>
      <fieldset disabled={busy || publishing}>
        <legend>Seating and prices</legend>
        <div className="form-pair">
          <Field label="Layout template" name="type" fields={fields}>
            {(props) => (
              <select
                {...props}
                value={type}
                onChange={(change) => setType(change.target.value)}
              >
                {Object.entries(templates).map(([value, { name }]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Currency code" name="currency" fields={fields}>
            {(props) => (
              <input
                {...props}
                value={currency}
                onChange={(change) =>
                  setCurrency(change.target.value.toUpperCase())
                }
                required
                maxLength={3}
                pattern="[A-Z]{3}"
              />
            )}
          </Field>
        </div>
        <div className="form-pair">
          {tiers.map((tier) => (
            <Field
              key={tier}
              label={`${tierNames[tier]} price (${currency || "currency"})`}
              name={`tierPrices.${tier}`}
              fields={fields}
            >
              {(props) => (
                <input
                  {...props}
                  value={prices[tier] ?? ""}
                  onChange={(change) =>
                    setPrices({ ...prices, [tier]: change.target.value })
                  }
                  required
                  maxLength={14}
                  inputMode="decimal"
                />
              )}
            </Field>
          ))}
        </div>
        <p className="support">
          {templates[type].sections.reduce(
            (total, section) =>
              total + section.rows.length * section.seatsPerRow,
            0,
          )}{" "}
          seats in this template.
        </p>
        {validPrices && (
          <>
            <button
              className="secondary-action"
              type="button"
              aria-expanded={preview}
              onClick={() => setPreview(!preview)}
            >
              {preview ? "Hide layout" : "Preview layout"}
            </button>
            {preview && (
              <SeatMap
                layout={buildLayout(type, tierPrices)}
                currency={currency}
              />
            )}
          </>
        )}
      </fieldset>
      <details className="sale-settings">
        <summary>Future sale settings</summary>
        <fieldset disabled={busy || publishing} className="form-pair">
          <legend>Queue and checkout defaults</legend>
          {settings.map(([name, label, initial, min, max]) => (
            <Field key={name} name={name} label={label} fields={fields}>
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={min}
                  max={max}
                  required
                  defaultValue={event?.[name] ?? initial}
                />
              )}
            </Field>
          ))}
        </fieldset>
      </details>
      <button type="submit" disabled={busy || publishing}>
        {busy ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}

function EditOrCreate() {
  const { id } = useParams();
  const { request, user } = useSession();
  const cache = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmationRevision, setConfirmationRevision] = useState(null);
  const queryKey = ["organizer", user.id, "event", id];
  const record = useQuery({
    queryKey,
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => request(`/organizer/events/${id}`, { signal }),
  });
  const event = record.data?.event;
  const needsReview = error?.code === "PUBLICATION_REVISION_CHANGED";

  async function reloadDraft() {
    const result = await record.refetch();
    if (!result.isSuccess) return;
    if (result.data.event.revision !== event.revision) setDirty(false);
    setError(null);
  }

  async function publish() {
    if (pending || dirty || confirmationRevision === null || needsReview)
      return;
    setPending(true);
    setError(null);
    try {
      const published = await request(`/organizer/events/${id}/publish`, {
        method: "POST",
        body: { revision: confirmationRevision },
      });
      cache.setQueryData(queryKey, published);
      cache.invalidateQueries({ queryKey: ["organizer", user.id, "events"] });
      cache.invalidateQueries({ queryKey: ["events"] });
      cache.invalidateQueries({ queryKey: ["event", id] });
    } catch (failure) {
      setError(failure);
      if (failure.code === "PUBLICATION_REVISION_CHANGED")
        setConfirmationRevision(null);
      if (failure.code === "TXN_COMMIT_UNCONFIRMED") record.refetch();
    } finally {
      setPending(false);
    }
  }
  return (
    <main id="main-content" className="shell product-page">
      <Link className="back-link" to="/organizer/events">
        Back to your events
      </Link>
      <h1>{event?.title ?? (id ? "Manage event" : "Create event")}</h1>
      {id && record.isPending && <Loading>Loading event…</Loading>}
      {id && record.isError && (
        <Failure
          error={record.error}
          retry={
            record.error.status === 404 ? undefined : () => record.refetch()
          }
        />
      )}
      {(!id || event?.status === "draft") && (
        <>
          <p className="support">
            {event
              ? "This draft is saved and visible only to you."
              : "Save your work as a draft before publishing it."}
          </p>
          <EventForm
            key={event ? `${event.id}-${event.revision}` : "new"}
            event={event}
            publishing={pending}
            reload={reloadDraft}
            onChange={() => {
              setDirty(true);
              setConfirmationRevision(null);
            }}
            onSaved={() => setDirty(false)}
          />
          {event && (
            <section
              className="publish-panel"
              aria-labelledby="publish-heading"
            >
              <h2 id="publish-heading">Publish saved draft</h2>
              <p>
                {dirty
                  ? "Save your changes before publishing."
                  : "Publishing makes the event public and creates its seat layout. The published layout is fixed."}
              </p>
              {error && <Failure error={error} />}
              {needsReview && (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={reloadDraft}
                  disabled={record.isFetching}
                >
                  {record.isFetching ? "Loading draft…" : "Load updated draft"}
                </button>
              )}
              {confirmationRevision !== null ? (
                <div className="actions">
                  <button type="button" onClick={publish} disabled={pending}>
                    {pending ? "Publishing…" : "Confirm publication"}
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => setConfirmationRevision(null)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmationRevision(event.revision)}
                  disabled={dirty || needsReview}
                >
                  Publish event
                </button>
              )}
            </section>
          )}
        </>
      )}
      {event && event.status !== "draft" && (
        <div className="publish-panel">
          <p role="status">Published · {event.totalSeats} seats</p>
          <Link to={`/events/${event.id}`}>View public event</Link>
        </div>
      )}
    </main>
  );
}

export function OrganizerList() {
  return (
    <OrganizerOnly>
      <OwnedList />
    </OrganizerOnly>
  );
}

export function OrganizerEvent() {
  const { id } = useParams();
  return (
    <OrganizerOnly>
      <EditOrCreate key={id ?? "new"} />
    </OrganizerOnly>
  );
}
