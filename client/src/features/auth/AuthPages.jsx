import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { api } from "../../lib/api.js";
import { PRODUCT_NAME } from "../../product.js";
import { Failure, Loading } from "../../ui.jsx";
import { GoogleButton } from "./GoogleButton.jsx";
import { useSession } from "./session.jsx";

const roleNames = {
  attendee: "Attendee",
  organizer: "Organizer",
  admin: "Admin",
  staff: "Staff",
};

export function Login() {
  const { status, notice, signIn, error, retry } = useSession();
  const { state } = useLocation();
  const [failure, setFailure] = useState(null);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const active = useRef(null);

  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(0), cooldown * 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const begin = useCallback(
    async (path, body) => {
      if (active.current || cooldown) return;
      const controller = new AbortController();
      active.current = controller;
      setFailure(null);
      setPending(true);
      try {
        const session = await api(path, {
          method: "POST",
          body,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) signIn(session);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFailure(error);
          setCooldown(error.retryAfter || 0);
        }
      } finally {
        active.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    },
    [cooldown, signIn],
  );

  const onGoogle = useCallback(
    (credential) => {
      if (credential) begin("/auth/google", { credential });
    },
    [begin],
  );

  if (status === "signed-in")
    return <Navigate to={state?.from ?? "/account"} replace />;
  const blocked = pending || cooldown > 0;
  return (
    <main id="main-content" className="shell product-page">
      <section className="auth-panel">
        <h1>Sign in</h1>
        <p className="support">
          Use your Google account or explore {PRODUCT_NAME} as a demo guest.
        </p>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {status === "loading" ? (
          <Loading>Checking your session…</Loading>
        ) : status === "error" ? (
          <Failure error={error} retry={retry} />
        ) : (
          <div className="auth-options">
            <GoogleButton
              key={cooldown > 0}
              onCredential={onGoogle}
              disabled={blocked}
            />
            <button
              type="button"
              disabled={blocked}
              onClick={() => begin("/auth/demo")}
            >
              Continue as a demo guest
            </button>
            <p className="support">
              Demo access uses a temporary attendee session.
            </p>
            {pending && <Loading>Signing in…</Loading>}
            {failure && <Failure error={failure} />}
          </div>
        )}
      </section>
    </main>
  );
}

function SessionGate({ children }) {
  const { status, error, retry, notice } = useSession();
  const { pathname } = useLocation();
  if (status === "signed-in") return children;
  return (
    <main id="main-content" className="shell product-page">
      <h1>Account access</h1>
      {status === "loading" && <Loading>Checking your session…</Loading>}
      {status === "error" && <Failure error={error} retry={retry} />}
      {status === "signed-out" && (
        <div className="notice">
          <p>{notice || "Sign in to continue."}</p>
          <Link to="/login" state={{ from: pathname }}>
            Sign in
          </Link>
        </div>
      )}
    </main>
  );
}

export function Account() {
  const { user, signOut } = useSession();
  return (
    <SessionGate>
      {user && (
        <main id="main-content" className="shell product-page">
          <section className="auth-panel">
            <h1>Account</h1>
            <dl className="facts">
              <div>
                <dt>Name</dt>
                <dd>{user.name}</dd>
              </div>
              {user.email && (
                <div>
                  <dt>Email</dt>
                  <dd>{user.email}</dd>
                </div>
              )}
              <div>
                <dt>Access</dt>
                <dd>{user.isGuest ? "Demo attendee" : roleNames[user.role]}</dd>
              </div>
            </dl>
            <div className="actions">
              {user.role === "organizer" && !user.isGuest && (
                <Link className="primary-action" to="/organizer/events">
                  Manage events
                </Link>
              )}
              <button
                className="secondary-action"
                type="button"
                onClick={() => signOut("Signed out.")}
              >
                Sign out
              </button>
            </div>
          </section>
        </main>
      )}
    </SessionGate>
  );
}

export function OrganizerOnly({ children }) {
  const { user } = useSession();
  return (
    <SessionGate>
      {user?.role === "organizer" && !user.isGuest ? (
        children
      ) : (
        <main id="main-content" className="shell product-page">
          <h1>Organizer access required</h1>
          <p className="notice">Your current account cannot manage events.</p>
          <Link to="/account">Go to account</Link>
        </main>
      )}
    </SessionGate>
  );
}
