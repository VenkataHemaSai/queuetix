import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./features/auth/session.jsx";
import { PRODUCT_NAME } from "./product.js";
import { Loading } from "./ui.jsx";

const Events = lazy(() =>
  import("./features/events/EventPages.jsx").then(({ Events }) => ({
    default: Events,
  })),
);
const EventDetail = lazy(() =>
  import("./features/events/EventPages.jsx").then(({ EventDetail }) => ({
    default: EventDetail,
  })),
);
const Login = lazy(() =>
  import("./features/auth/AuthPages.jsx").then(({ Login }) => ({
    default: Login,
  })),
);
const Account = lazy(() =>
  import("./features/auth/AuthPages.jsx").then(({ Account }) => ({
    default: Account,
  })),
);
const OrganizerList = lazy(() =>
  import("./features/events/OrganizerPages.jsx").then(({ OrganizerList }) => ({
    default: OrganizerList,
  })),
);
const OrganizerEvent = lazy(() =>
  import("./features/events/OrganizerPages.jsx").then(({ OrganizerEvent }) => ({
    default: OrganizerEvent,
  })),
);
const Smoke = lazy(() =>
  import("./smoke/SmokePage.jsx").then(({ SmokePage }) => ({
    default: SmokePage,
  })),
);

function Header({ smoke }) {
  const { status, user } = useSession();
  const [open, setOpen] = useState(false);
  const toggle = useRef(null);
  const close = () => setOpen(false);
  const signedIn = status === "signed-in";
  return (
    <header
      className="site-header"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          close();
          toggle.current?.focus();
        }
      }}
    >
      <div className="shell app-header">
        <Link className="wordmark" to="/" onClick={close}>
          {PRODUCT_NAME}
        </Link>
        <button
          ref={toggle}
          type="button"
          className="secondary-action menu-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen(!open)}
        >
          {open ? "Close menu" : "Menu"}
        </button>
        <nav
          id="primary-nav"
          aria-label="Main navigation"
          className={open ? "menu-open" : ""}
        >
          <NavLink to="/events" onClick={close}>
            Events
          </NavLink>
          {signedIn && user.role === "organizer" && (
            <NavLink to="/organizer/events" onClick={close}>
              Manage events
            </NavLink>
          )}
          {status !== "loading" && (
            <NavLink
              to={signedIn || status === "error" ? "/account" : "/login"}
              onClick={close}
            >
              {signedIn || status === "error" ? "Account" : "Sign in"}
            </NavLink>
          )}
          {smoke && (
            <NavLink to="/smoke" onClick={close}>
              Service checks
            </NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}

export function App() {
  const { pathname } = useLocation();
  const smoke = /^\/smoke\/?$/.test(pathname);
  useEffect(() => {
    const page = smoke
      ? "Service checks"
      : pathname.startsWith("/organizer")
        ? "Manage events"
        : pathname === "/login"
          ? "Sign in"
          : pathname === "/account"
            ? "Account"
            : "Events";
    document.title = `${page} | ${PRODUCT_NAME}`;
  }, [pathname, smoke]);
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header key={pathname} smoke={smoke} />
      <Suspense
        fallback={
          <main id="main-content" className="shell product-page">
            <Loading />
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<Events home />} />
          <Route path="/events" element={<Events />} />
          <Route path="/events/:id" element={<EventDetail />} />
          <Route path="/login" element={<Login />} />
          <Route path="/account" element={<Account />} />
          <Route path="/organizer/events" element={<OrganizerList />} />
          <Route path="/organizer/events/new" element={<OrganizerEvent />} />
          <Route path="/organizer/events/:id" element={<OrganizerEvent />} />
          <Route path="/smoke" element={<Smoke />} />
          <Route
            path="*"
            element={
              <main id="main-content" className="shell product-page">
                <h1>Page unavailable</h1>
                <Link to="/events">Browse events</Link>
              </main>
            }
          />
        </Routes>
      </Suspense>
    </>
  );
}
