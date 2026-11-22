import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/instrument-sans";
import { App } from "./App.jsx";
import { SessionProvider } from "./features/auth/session.jsx";
import "./styles.css";
import "./product.css";

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 20_000 } },
});

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <QueryClientProvider client={queries}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </QueryClientProvider>
  </BrowserRouter>,
);
