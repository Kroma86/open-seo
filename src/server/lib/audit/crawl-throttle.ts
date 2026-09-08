/** Retries per URL after its first 429. Every 429 still pauses new URLs. */
const MAX_RETRIES = 3;
const FIRST_DELAY_MS = 1_000;

/** `Retry-After` is either delay-seconds or an HTTP-date. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export interface CrawlThrottle {
  /** False when this chunk can no longer start a request. */
  ready(): Promise<boolean>;
  /** Pause the origin on every 429; return whether this URL may retry. */
  backoff(attempt: number, retryAfter: string | null): boolean;
  readonly stopped: boolean;
}

/** One origin cooldown, bounded by the scheduler's existing chunk deadline. */
export function createCrawlThrottle(deadlineAt: number): CrawlThrottle {
  let pausedUntil = 0;
  let stopped = false;
  return {
    async ready() {
      // Another request can extend the shared pause while this one waits.
      while (pausedUntil > Date.now()) {
        if (stopped) return false;
        await new Promise((resolve) =>
          setTimeout(resolve, pausedUntil - Date.now()),
        );
      }
      return !stopped && Date.now() < deadlineAt;
    },
    backoff(attempt, retryAfter) {
      const delayMs = Math.max(
        FIRST_DELAY_MS,
        parseRetryAfterMs(retryAfter) ?? FIRST_DELAY_MS * 2 ** (attempt - 1),
      );
      pausedUntil = Math.max(pausedUntil, Date.now() + delayMs);
      // Never shorten the site's requested wait to fit our budget. Stop the
      // crawl instead; the scheduler preserves unvisited URLs as incomplete.
      if (pausedUntil >= deadlineAt) stopped = true;
      return !stopped && attempt <= MAX_RETRIES;
    },
    get stopped() {
      return stopped;
    },
  };
}
