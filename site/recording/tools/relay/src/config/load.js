import { readFileSync } from "node:fs";
import { parseDuration } from "./duration.js";

const DEFAULTS = { concurrency: 1, timeout: "10m", backoff: "30s", attempts: 3 };

export function loadConfig(path = "relay.config.json") {
  return normalize(JSON.parse(readFileSync(path, "utf8")));
}

export function normalize(raw) {
  const queues = {};
  for (const [name, queue] of Object.entries(raw.queues ?? {})) {
    const q = { ...DEFAULTS, ...queue };
    queues[name] = {
      concurrency: q.concurrency,
      attempts: q.attempts,
      timeoutMs: parseDuration(q.timeout),
      backoffMs: parseDuration(q.backoff),
    };
  }
  return { queues, pollMs: parseDuration(raw.poll ?? "1s") };
}
