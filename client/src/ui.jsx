import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export function Loading({ children = "Loading…" }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4500);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p className="notice" role="status">
      {slow
        ? "Connecting to the ticket service. It may be waking up."
        : children}
    </p>
  );
}

export function Failure({ error, retry }) {
  return (
    <div className="notice notice-error" role="alert">
      <p>{error?.message ?? "Something went wrong."}</p>
      {retry && (
        <button className="secondary-action" type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Pagination({ page, hasNext, path }) {
  if (page <= 1 && !hasNext) return null;
  return (
    <nav className="pagination" aria-label="Event pages">
      {page > 1 && <Link to={`${path}?page=${page - 1}`}>Previous</Link>}
      <span>Page {page}</span>
      {hasNext && <Link to={`${path}?page=${page + 1}`}>Next</Link>}
    </nav>
  );
}
