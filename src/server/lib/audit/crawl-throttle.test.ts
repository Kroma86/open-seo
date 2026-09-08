import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";

afterEach(() => {
  vi.useRealTimers();
});

describe("createCrawlThrottle", () => {
  it("backs off exponentially and still pauses after a URL exhausts its retries", async () => {
    vi.useFakeTimers();
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    for (const [attempt, delay] of [
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
      [4, 8_000],
    ]) {
      expect(throttle.backoff(attempt, null)).toBe(attempt <= 3);
      let ready = false;
      const waiting = throttle.ready().then((result) => {
        ready = result;
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(ready).toBe(true);
    }
  });

  it.each(["60", "Thu, 01 Jan 2026 00:01:00 GMT"])(
    "honors a full sixty-second Retry-After: %s",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const throttle = createCrawlThrottle(Date.now() + 90_000);
      expect(throttle.backoff(1, retryAfter)).toBe(true);
      let ready = false;
      const waiting = throttle.ready().then((result) => {
        ready = result;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(ready).toBe(true);
    },
  );

  it("does not label an ordinary chunk deadline as a rate-limit stop", async () => {
    vi.useFakeTimers();
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await throttle.ready()).toBe(false);
    expect(throttle.stopped).toBe(false);
  });

  it("stops without scheduling a timer when the cooldown exceeds the crawl budget", async () => {
    vi.useFakeTimers();
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    expect(throttle.backoff(1, "600")).toBe(false);
    expect(throttle.stopped).toBe(true);
    expect(await throttle.ready()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds a waiter through a pause that another 429 extends", async () => {
    vi.useFakeTimers();
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    throttle.backoff(1, "1");
    let released = false;
    const waiting = throttle.ready().then((result) => {
      released = result;
    });
    await vi.advanceTimersByTimeAsync(900);
    throttle.backoff(1, "1");
    await vi.advanceTimersByTimeAsync(200);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    await waiting;
    expect(released).toBe(true);
  });
});
