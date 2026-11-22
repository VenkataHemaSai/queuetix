const rows = (count) =>
  Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index));
const section = (
  id,
  name,
  count,
  seatsPerRow,
  aisleAfter,
  tiers,
  prefix = "",
) => ({
  id,
  name,
  rows: rows(count),
  seatsPerRow,
  aisleAfter,
  tiers,
  prefix,
});

export const tierNames = {
  front: "Front",
  standard: "Standard",
  premium: "Premium",
  value: "Value",
};

export const templates = {
  cinema: {
    name: "Cinema",
    stage: "Screen",
    tiers: ["front", "standard", "premium"],
    sections: [
      section(
        "main",
        "Main auditorium",
        10,
        12,
        [6],
        [
          "front",
          "front",
          "front",
          "standard",
          "standard",
          "standard",
          "standard",
          "premium",
          "premium",
          "premium",
        ],
      ),
    ],
  },
  bus: {
    name: "Bus",
    stage: "Front of bus",
    tiers: ["standard"],
    sections: [
      section(
        "main",
        "Passenger cabin",
        10,
        4,
        [2],
        Array(10).fill("standard"),
      ),
    ],
  },
  concert: {
    name: "Concert",
    stage: "Stage",
    tiers: ["premium", "standard", "value"],
    sections: [
      section("a", "Section A", 5, 8, [4], Array(5).fill("premium"), "A-"),
      section("b", "Section B", 7, 10, [5], Array(7).fill("standard"), "B-"),
      section("c", "Section C", 6, 10, [5], Array(6).fill("value"), "C-"),
    ],
  },
};

export function buildLayout(type, tierPrices) {
  const { sections, stage, tiers } = templates[type];
  return {
    type,
    stage,
    sections: structuredClone(sections),
    tierPrices: Object.fromEntries(
      tiers.map((tier) => [tier, tierPrices[tier]]),
    ),
  };
}

export function layoutSeats(layout) {
  let seatIndex = 0;
  return layout.sections.flatMap(
    ({ id, rows, seatsPerRow, prefix, aisleAfter, tiers }) =>
      rows.flatMap((letter, row) => {
        const tier = tiers[row];
        return Array.from({ length: seatsPerRow }, (_, position) => {
          const number = position + 1;
          return {
            label: `${prefix}${letter}${number}`,
            section: id,
            row,
            col: position + aisleAfter.filter((after) => number > after).length,
            tier,
            price: layout.tierPrices[tier],
            seatIndex: seatIndex++,
            ...(layout.type === "bus" && {
              window: number === 1 || number === seatsPerRow,
            }),
          };
        });
      }),
  );
}
