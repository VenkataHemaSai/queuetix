import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Empty, Failure, Loading } from "../../ui.jsx";
import { useSession } from "../auth/session.jsx";
import { formatDate } from "../events/presentation.js";
import { OperationsAccess } from "./access.jsx";
import "./operations.css";

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}
function cameraMessage(error) {
  if (error.name === "NotAllowedError" || error.name === "SecurityError")
    return "Camera access was denied. Allow it in your browser settings or enter the ticket code below.";
  if (["NotFoundError", "NotReadableError"].includes(error.name))
    return "The camera is unavailable. Check the device or enter the ticket code below.";
  return "The camera could not start. Try again or enter the ticket code below.";
}

function EventScanner({ event }) {
  const { user, request } = useSession();
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState("off");
  const [cameraError, setCameraError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [fault, setFault] = useState(null);
  const capture = useRef(null);
  const pending = useRef(null);
  const preview = useRef(null);
  const history = useQuery({
    queryKey: ["staff", user.id, event.id, "scans"],
    queryFn: ({ signal }) =>
      request("/staff/events/" + event.id + "/scans", { signal }),
  });

  const releaseCamera = useCallback(() => {
    const active = capture.current;
    if (!active) return;
    capture.current = null;
    active.controls?.stop();
    stopTracks(active.stream);
    if (preview.current) preview.current.srcObject = null;
  }, []);

  useEffect(
    () => () => {
      releaseCamera();
      pending.current?.abort();
    },
    [releaseCamera],
  );

  async function validate(payload) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    releaseCamera();
    setCamera("off");
    setBusy(true);
    setResult(null);
    setFault(null);
    setCode("");
    try {
      const response = await request("/tickets/validate", {
        method: "POST",
        body: { eventId: event.id, payload },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setResult(response);
        void history.refetch();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure.code === "ALREADY_USED") {
          setResult({ ...failure.fields, status: "used" });
          void history.refetch();
        } else if (failure.code === "INVALID_TICKET") {
          setResult({ status: "invalid" });
        } else {
          setFault(failure);
        }
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function start() {
    if (capture.current || pending.current) return;
    const active = {};
    capture.current = active;
    setCamera("starting");
    setCameraError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Camera unavailable");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (capture.current !== active) {
        stopTracks(stream);
        return;
      }
      active.stream = stream;
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (capture.current !== active) return;
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromStream(
        stream,
        preview.current,
        (decoded) => {
          if (decoded && capture.current === active)
            void validate(decoded.getText());
        },
      );
      if (capture.current !== active) {
        controls.stop();
        return;
      }
      active.controls = controls;
      setCamera("on");
    } catch (error) {
      if (capture.current !== active) return;
      releaseCamera();
      setCamera("off");
      setCameraError({ message: cameraMessage(error) });
    }
  }

  return (
    <div className="ops-sections">
      <section className="booking-card" aria-labelledby="scan-heading">
        <h2 id="scan-heading">Validate a ticket</h2>
        <p>
          {event.title} · {event.venue}
        </p>
        <video
          aria-label="Camera preview"
          className="scanner-preview"
          ref={preview}
          autoPlay
          playsInline
          muted
          hidden={camera === "off"}
        />
        {camera === "off" ? (
          <button type="button" disabled={busy} onClick={start}>
            Start camera
          </button>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                releaseCamera();
                setCamera("off");
              }}
            >
              Stop camera
            </button>
            {camera === "starting" && <p role="status">Opening camera…</p>}
          </div>
        )}
        {cameraError && <Failure error={cameraError} />}
        <form
          className="scanner-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim()) void validate(code.trim());
          }}
        >
          <label>
            Ticket code{" "}
            <input
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="secondary-action"
            disabled={busy || !code.trim()}
          >
            Validate code
          </button>
        </form>
        {busy && <Loading>Validating ticket…</Loading>}
        {fault && <Failure error={fault} />}
        {result && <ScanResult result={result} zone={event.timeZone} />}
      </section>
      <section
        className="booking-card scanner-history"
        aria-labelledby="history-heading"
      >
        <h2 id="history-heading">Recent check-ins</h2>
        {history.isPending && <Loading>Loading check-ins…</Loading>}
        {history.isError && (
          <Failure error={history.error} retry={() => history.refetch()} />
        )}
        {history.data &&
          (history.data.scans.length ? (
            <ul className="booking-lines">
              {history.data.scans.map((scan) => (
                <li key={scan.id}>
                  <strong>
                    {scan.seat ? "Seat " + scan.seat.label : "Seat unavailable"}
                  </strong>
                  <span>
                    Used ·{" "}
                    <time dateTime={scan.scannedAt}>
                      {formatDate(scan.scannedAt, event.timeZone)}
                    </time>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No tickets have been redeemed for this event.</p>
          ))}
      </section>
    </div>
  );
}

function ScanResult({ result, zone }) {
  const labels = { valid: "Valid", used: "Already used", invalid: "Invalid" };
  const marks = { valid: "✓", used: "!", invalid: "×" };
  return (
    <div
      className={"notice" + (result.status === "valid" ? "" : " notice-error")}
      role="status"
    >
      <p>
        <span aria-hidden="true">{marks[result.status]} </span>
        <strong>{labels[result.status]}</strong>
      </p>
      {result.seat && (
        <p>
          {result.event.title} · Seat {result.seat.label}
        </p>
      )}
      {result.scannedAt && (
        <p>
          Checked in{" "}
          <time dateTime={result.scannedAt}>
            {formatDate(result.scannedAt, zone)}
          </time>
        </p>
      )}
      {result.status === "invalid" && (
        <p>Check that the ticket is for the selected event.</p>
      )}
    </div>
  );
}

function ScannerPage() {
  const { user, request } = useSession();
  const [selected, setSelected] = useState("");
  const query = useQuery({
    queryKey: ["staff", user.id, "events"],
    queryFn: ({ signal }) => request("/staff/events", { signal }),
  });
  const events = query.data?.events ?? [];
  const event = events.find(({ id }) => id === selected) ?? events[0];
  return (
    <main id="main-content" className="shell product-page ops-page">
      <h1>Staff scanner</h1>
      <p className="support">Signed in as {user.name}</p>
      {query.isPending && <Loading>Loading assigned events…</Loading>}
      {query.isError && (
        <Failure error={query.error} retry={() => query.refetch()} />
      )}
      {query.data && !events.length && (
        <Empty title="No assigned events">
          Ask an administrator to assign your staff account to an event.
        </Empty>
      )}
      {event && (
        <>
          <label className="scanner-event">
            Select event
            <select
              value={event.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {events.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <EventScanner key={event.id} event={event} />
        </>
      )}
    </main>
  );
}

export function StaffScanner() {
  return (
    <OperationsAccess roles={["staff"]} title="Staff">
      <ScannerPage />
    </OperationsAccess>
  );
}
