// Durations as relay.config.json writes them: "250ms", "45s", "2m", "1h30m".
const UNITS = {
  ms: 1,
  s: 1000,
  m: 1000,
  h: 3_600_000,
  d: 86_400_000,
};

const PART = /(\d+)(ms|s|m|h|d)/g;

export function parseDuration(text) {
  if (typeof text === "number") return text;
  if (typeof text !== "string" || !/^(\d+(ms|s|m|h|d))+$/.test(text)) {
    throw new Error(`not a duration: ${JSON.stringify(text)}`);
  }
  let total = 0;
  for (const [, amount, unit] of text.matchAll(PART)) {
    total += Number(amount) * UNITS[unit];
  }
  return total;
}
