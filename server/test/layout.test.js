import { buildLayout, layoutSeats } from "../../shared/seat-layout.js";

test("T-LAYOUT-1 cinema produces unique A1–J12 labels with a real aisle", () => {
  const layout = buildLayout("cinema", {
    front: 20000,
    standard: 30000,
    premium: 40000,
  });
  const seats = layoutSeats(layout);
  expect(seats).toHaveLength(120);
  expect(new Set(seats.map(({ label }) => label)).size).toBe(120);
  expect(seats[0]).toMatchObject({
    label: "A1",
    seatIndex: 0,
    section: "main",
    col: 0,
    price: 20000,
  });
  expect(seats[119]).toMatchObject({
    label: "J12",
    seatIndex: 119,
    tier: "premium",
  });
  expect(seats.slice(0, 12).map(({ col }) => col)).toEqual([
    0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12,
  ]);
  expect(layoutSeats(JSON.parse(JSON.stringify(layout)))).toEqual(seats);
});

test("T-LAYOUT-2 bus has a 2+2 grid and honest window positions", () => {
  const seats = layoutSeats(buildLayout("bus", { standard: 20000 }));
  expect(seats).toHaveLength(40);
  expect(
    seats.slice(0, 4).map(({ label, col, window }) => [label, col, window]),
  ).toEqual([
    ["A1", 0, true],
    ["A2", 1, false],
    ["A3", 3, false],
    ["A4", 4, true],
  ]);
});

test("concert labels and indexes are unique across sections", () => {
  const seats = layoutSeats(
    buildLayout("concert", { premium: 40000, standard: 30000, value: 20000 }),
  );
  expect(new Set(seats.map(({ section }) => section))).toEqual(
    new Set(["a", "b", "c"]),
  );
  expect(new Set(seats.map(({ label }) => label)).size).toBe(seats.length);
  expect(seats.map(({ seatIndex }) => seatIndex)).toEqual(
    seats.map((_, index) => index),
  );
});
