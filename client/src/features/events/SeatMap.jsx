import { useId, useMemo, useState } from "react";
import { layoutSeats, tierNames } from "../../../../shared/seat-layout.js";
import { formatPrice } from "./presentation.js";

const cell = 36;

export function SeatMap({ layout, currency, seatState }) {
  const id = useId();
  const [fit, setFit] = useState(false);
  const seats = useMemo(() => layoutSeats(layout), [layout]);

  return (
    <div className="seat-map">
      <div className="map-controls">
        <p className="support">
          Scroll sideways for the full layout or fit it to the panel.
        </p>
        <button
          className="secondary-action"
          type="button"
          aria-pressed={fit}
          onClick={() => setFit(!fit)}
        >
          Fit to width
        </button>
      </div>
      <ul className="tier-legend" aria-label="Price tiers">
        {Object.entries(layout.tierPrices).map(([tier, price]) => (
          <li key={tier}>
            <span className={`tier-key tier-${tier}`} aria-hidden="true" />
            {tierNames[tier]} <strong>{formatPrice(price, currency)}</strong>
          </li>
        ))}
      </ul>
      <div className="map-stage">{layout.stage}</div>
      {layout.sections.map((section) => {
        const sectionSeats = seats.filter(
          (seat) => seat.section === section.id,
        );
        const width =
          cell * (section.seatsPerRow + section.aisleAfter.length) + 36;
        const svgId = `${id}-${section.id}`;
        return (
          <section
            className="map-section"
            key={section.id}
            aria-labelledby={`${svgId}-name`}
          >
            <h3 id={`${svgId}-name`}>{section.name}</h3>
            <div
              className={`map-scroll${fit ? " map-fit" : ""}`}
              tabIndex={0}
              role="region"
              aria-label={`${section.name} map`}
            >
              <svg
                role="img"
                aria-labelledby={`${svgId}-title`}
                width={width}
                height={section.rows.length * cell + 8}
                viewBox={`0 0 ${width} ${section.rows.length * cell + 8}`}
              >
                <title id={`${svgId}-title`}>{section.name} seat layout</title>
                {section.rows.map((letter, row) => (
                  <text
                    key={letter}
                    x="4"
                    y={row * cell + 24}
                    className="row-letter"
                  >
                    {letter}
                  </text>
                ))}
                {sectionSeats.map(({ label, row, col, tier, seatIndex }) => (
                  <g
                    key={seatIndex}
                    data-seat-index={seatIndex}
                    data-state={seatState?.[seatIndex]}
                    transform={`translate(${28 + col * cell}, ${7 + row * cell})`}
                  >
                    <rect
                      width="31"
                      height="26"
                      rx="4"
                      className={`seat-cell tier-${tier}`}
                    />
                    <text x="15.5" y="13" dy=".36em" textAnchor="middle">
                      {section.prefix
                        ? label.slice(section.prefix.length)
                        : label}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
            <details className="seat-text">
              <summary>Seat labels and prices by row</summary>
              <ul>
                {section.rows.map((letter, row) => {
                  const rowSeats = sectionSeats.filter(
                    (seat) => seat.row === row,
                  );
                  return (
                    <li key={letter}>
                      <strong>
                        Row {letter} · {tierNames[rowSeats[0].tier]} ·{" "}
                        {formatPrice(rowSeats[0].price, currency)}
                      </strong>
                      <br />
                      {rowSeats.map(({ label }) => label).join(", ")}
                    </li>
                  );
                })}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}
