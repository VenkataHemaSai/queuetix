import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import { SmokePage } from "./smoke/SmokePage.jsx";
import { PRODUCT_NAME } from "./product.js";
import "./styles.css";

const isSmoke = ["/", "/smoke", "/smoke/"].includes(window.location.pathname);

createRoot(document.getElementById("root")).render(
  <>
    <header className="site-header">
      <div className="shell">
        <a className="wordmark" href="/smoke">
          {PRODUCT_NAME}
        </a>
      </div>
    </header>
    {isSmoke ? (
      <SmokePage />
    ) : (
      <main className="shell page">
        <h1>Page unavailable</h1>
        <p>
          <a href="/smoke">Open service checks</a>
        </p>
      </main>
    )}
  </>,
);
