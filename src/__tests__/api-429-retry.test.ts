/**
 * Tests for the 429 rate-limit retry ring added to the shared postJson helper.
 *
 * Ported semantics from openclaw-channel-octo: a bounded backoff that engages ONLY
 * on HTTP 429 (default on), honours Retry-After without shortening it, and gives up
 * at the attempt cap / retry-after ceiling. Non-429 errors are thrown immediately.
 *
 * The three required paths are covered explicitly:
 *   1. retry then succeed
 *   2. keep getting 429 → give up at the cap
 *   3. a non-429 error is thrown straight through with no retry
 * plus the retryOn429:false opt-out and the Retry-After ceiling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postJson, MAX_429_RETRIES } from "../octo/api.js";
import { OctoApiError } from "../octo/api-error.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Minimal Response-like stub. `retryAfter` is emitted as a Retry-After header in
 * seconds; the tiny default (1ms once converted) keeps the real backoff sleeps fast.
 */
function resp(opts: {
  ok: boolean;
  status: number;
  body?: string;
  statusText?: string;
  retryAfter?: string;
  rateLimitScope?: string;
  rateLimitRemaining?: string;
}): unknown {
  const headers: Record<string, string> = {};
  if (opts.retryAfter !== undefined) headers["Retry-After"] = opts.retryAfter;
  if (opts.rateLimitScope !== undefined) headers["X-RateLimit-Scope"] = opts.rateLimitScope;
  if (opts.rateLimitRemaining !== undefined) headers["X-RateLimit-Remaining"] = opts.rateLimitRemaining;
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.statusText ?? "",
    headers: { get: (name: string): string | null => headers[name] ?? null },
    text: () => Promise.resolve(opts.body ?? ""),
  };
}

const rateLimited = (): unknown =>
  resp({ ok: false, status: 429, body: "slow down", retryAfter: "0.001", rateLimitScope: "bot", rateLimitRemaining: "0" });
const ok = (body: string): unknown => resp({ ok: true, status: 200, body });

describe("postJson 429 retry ring", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Silence the per-429 console.warn so the suite output stays clean.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a 429 and succeeds on the follow-up attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok('{"result":"ok"}'));

    const result = await postJson<{ result: string }>(
      "https://api.example.com",
      "token",
      "/v1/bot/sendMessage",
      { hello: "world" },
    );

    expect(result).toEqual({ result: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry cap when 429s never stop", async () => {
    mockFetch.mockResolvedValue(rateLimited());

    const err = await postJson("https://api.example.com", "token", "/v1/bot/sendMessage", {})
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OctoApiError);
    expect((err as OctoApiError).status).toBe(429);
    expect((err as OctoApiError).isRateLimited).toBe(true);
    // Original attempt + MAX_429_RETRIES retries.
    expect(mockFetch).toHaveBeenCalledTimes(MAX_429_RETRIES + 1);
  });

  it("throws a non-429 error immediately without retrying", async () => {
    mockFetch.mockResolvedValue(
      resp({ ok: false, status: 500, body: "boom" }),
    );

    const err = await postJson("https://api.example.com", "token", "/v1/bot/sendMessage", {})
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OctoApiError);
    expect((err as OctoApiError).status).toBe(500);
    expect((err as Error).message).toBe("Octo API /v1/bot/sendMessage failed (500): boom");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 when retryOn429 is false", async () => {
    mockFetch.mockResolvedValue(rateLimited());

    const err = await postJson(
      "https://api.example.com",
      "token",
      "/v1/bot/events",
      {},
      undefined,
      { retryOn429: false },
    ).then(() => undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OctoApiError);
    expect((err as OctoApiError).status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up immediately when the server's wait exceeds the retry ceiling", async () => {
    // Retry-After 20s is beyond MAX_RETRY_AFTER_MS (10s): retrying would just return
    // before the server is ready, so postJson throws without sleeping or re-fetching.
    mockFetch.mockResolvedValue(
      resp({ ok: false, status: 429, body: "back off", retryAfter: "20" }),
    );

    const err = await postJson("https://api.example.com", "token", "/v1/bot/sendMessage", {})
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OctoApiError);
    expect((err as OctoApiError).status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the scope/remaining rate-limit hints on the surfaced error", async () => {
    mockFetch.mockResolvedValue(rateLimited());

    const err = await postJson(
      "https://api.example.com",
      "token",
      "/v1/bot/sendMessage",
      {},
      undefined,
      { retryOn429: false },
    ).then(() => undefined).catch((e: unknown) => e);

    expect((err as OctoApiError).rateLimitScope).toBe("bot");
    expect((err as OctoApiError).rateLimitRemaining).toBe("0");
    expect((err as OctoApiError).retryAfterMs).toBe(1);
  });
});
