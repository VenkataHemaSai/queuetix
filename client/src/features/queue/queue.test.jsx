// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SessionProvider } from "../auth/session.jsx";
import { api, stream } from "../../lib/api.js";
import { WaitingRoom } from "./WaitingRoom.jsx";

vi.mock("../../lib/api.js", async (original) => ({
  ...(await original()),
  api: vi.fn(),
  stream: vi.fn(),
}));
const serverTime = "2027-01-01T12:00:00Z";
const state = {
  serverTime,
  startsAt: "2027-01-02T12:00:00Z",
  saleStartsAt: serverTime,
  eventStatus: "on_sale",
  saleClosed: false,
  connection: "connected",
  canRejoin: false,
  entry: { status: "waiting", number: 8 },
  approximatePosition: 6,
  etaMinutes: null,
  seatsRemaining: 12,
  pass: null,
};

function show(data = state) {
  window.sessionStorage.setItem(
    "queuetix.session",
    JSON.stringify({
      token: "test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  api.mockImplementation(async (path) => {
    if (path === "/me") return { user: { id: "user", role: "attendee" } };
    if (path.endsWith("/queue/me")) return data;
    return { event: { title: "Cinema demo", isDemo: true }, serverTime };
  });
  let connection;
  stream.mockImplementation((_path, options) => {
    connection = options;
    options.onOpen();
    return Promise.resolve();
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/events/event/queue"]}>
        <SessionProvider>
          <Routes>
            <Route path="/events/:id/queue" element={<WaitingRoom />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client, connection: () => connection };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.resetAllMocks();
});

test("temporary disconnect displays reconnecting and withholds unsupported ETA", async () => {
  const { connection, unmount } = show();
  await screen.findByText("About #6");
  expect(screen.getByText("Calculating wait time...")).toBeTruthy();
  await screen.findByText("Connected");
  const current = connection();
  await import("@testing-library/react").then(({ act }) =>
    act(() => current.onDisconnect()),
  );
  await screen.findByText("Reconnecting");
  expect(screen.queryByText(/removed from the queue/i)).toBeNull();
  expect(stream).toHaveBeenCalledTimes(1);
  unmount();
  expect(current.signal.aborted).toBe(true);
});

test("refresh restores server admission and an expiry update exposes rejoin", async () => {
  const { connection } = show({
    ...state,
    entry: { status: "admitted", number: 8 },
    approximatePosition: null,
    pass: { expiresAt: "2027-01-01T12:10:00Z" },
  });
  expect(
    (await screen.findByRole("link", { name: "Choose seats" })).getAttribute(
      "href",
    ),
  ).toBe("/events/event/book");
  await import("@testing-library/react").then(({ act }) =>
    act(() =>
      connection().onMessage({
        event: "pass:expired",
        data: JSON.stringify({
          ...state,
          entry: { status: "expired", number: 8 },
          approximatePosition: null,
          canRejoin: true,
        }),
      }),
    ),
  );
  expect(await screen.findByText("Your admission pass expired")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rejoin queue" }));
  expect(api).toHaveBeenCalledWith(
    "/events/event/queue/rejoin",
    expect.objectContaining({
      method: "POST",
      body: { idempotencyKey: expect.any(String) },
    }),
  );
});

test("a delayed queue refresh cannot replace a newer streamed position", async () => {
  let finishRefresh;
  const pending = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const { client, connection } = show(pending);
  await waitFor(() => expect(connection()).toBeTruthy());
  act(() =>
    connection().onMessage({
      event: "queue",
      data: JSON.stringify({
        ...state,
        serverTime: "2027-01-01T12:00:01Z",
        approximatePosition: 2,
      }),
    }),
  );
  await screen.findByText("About #2");
  await act(async () => finishRefresh(state));
  await waitFor(() =>
    expect(client.isFetching({ queryKey: ["booking"] })).toBe(0),
  );
  expect(screen.getByText("About #2")).toBeTruthy();
  expect(screen.queryByText("About #6")).toBeNull();
});
