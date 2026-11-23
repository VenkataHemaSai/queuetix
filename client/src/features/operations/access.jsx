import { Link } from "react-router-dom";
import { SessionGate } from "../auth/AuthPages.jsx";
import { useSession } from "../auth/session.jsx";
import "../booking/booking.css";

export function OperationsAccess({ roles, title, children }) {
  const { user } = useSession();
  return (
    <SessionGate>
      {user && !user.isGuest && roles.includes(user.role) ? (
        children
      ) : (
        <main id="main-content" className="shell product-page">
          <h1>{title} access required</h1>
          <p className="notice">Your current account cannot open this page.</p>
          <Link to="/account">Go to account</Link>
        </main>
      )}
    </SessionGate>
  );
}
