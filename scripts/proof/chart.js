import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../../docs/evidence/", import.meta.url);
const { f3 } = JSON.parse(
  await readFile(new URL("benchmarks.json", root), "utf8"),
);
const minutes = Array(Math.floor(f3.result.wallMs / 60000) + 1).fill(0);
for (const { wallMs, admitted } of f3.result.timeline)
  minutes[Math.floor(wallMs / 60000)] += admitted;
const max = Math.max(...minutes, 1);
const bars = minutes
  .map((n, i) => {
    const y = 72 + i * 42,
      w = Math.round((390 * n) / max);
    return (
      '<text x="18" y="' +
      (y + 15) +
      '">' +
      i * 60 +
      "–" +
      (i + 1) * 60 +
      ' s</text><rect x="125" y="' +
      y +
      '" width="' +
      w +
      '" height="20" fill="#145c52"/><text x="' +
      (135 + w) +
      '" y="' +
      (y + 15) +
      '">' +
      n +
      "</text>"
    );
  })
  .join("\n");
const height = 82 + minutes.length * 42;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 585 ' +
  height +
  '" role="img" aria-labelledby="title desc"><title id="title">F3 admissions by elapsed minute</title><desc id="desc">Counts of newly admitted users per minute of wall time, in order: ' +
  minutes.join(", ") +
  '. The last minute is partial.</desc><rect width="585" height="' +
  height +
  '" fill="#f8f7f3"/><g fill="#1d2524" font-family="system-ui, sans-serif" font-size="15"><text x="18" y="30" font-size="21" font-weight="bold">F3 admissions by elapsed minute</text><text x="18" y="53">Local service run · recorded passes · last interval partial</text>' +
  bars +
  "</g></svg>\n";
await writeFile(new URL("admissions.svg", root), svg);
