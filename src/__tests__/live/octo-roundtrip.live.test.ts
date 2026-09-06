/**
 * Live integration test — real register → WS → send/receive → receipt → card →
 * upload → reconnect against a REAL octo-server. This is the one suite that is
 * NOT mocked: every other test in this repo stubs `../octo/api.js`, so nothing
 * exercises the actual on-the-wire contract (register handshake, WuKongIM binary
 * protocol, presigned PUT, type-17 card acceptance). This file closes that gap.
 *
 * ── When the suite runs vs skips (no false greens) ───────────────────────────
 *   The suite SKIPS in exactly TWO cases, both legitimate:
 *     1. `OCTO_LIVE` is unset — the default `npm test` / PR CI path. Zero network.
 *     2. `OCTO_LIVE=1`, all env present, but the `GET /v1/ping` probe finds the
 *        server network-unreachable (DNS/refused/timeout). This is the only
 *        spec-allowed live skip.
 *   Under `OCTO_LIVE=1`, EVERYTHING else is a real FAILURE, never a skip:
 *     - a missing required env var → the env-completeness test fails;
 *     - a failing register handshake → the register-roundtrip test fails.
 *   Swallowing either into a skip would be a false green — the exact bug this
 *   file must not have.
 *
 * ── Safety / isolation ───────────────────────────────────────────────────────
 *   - Credentials come ONLY from the environment (source the restricted
 *     `octo.env` before running). No token/id is ever written to source, a
 *     snapshot, a log line, or a comment.
 *   - Every message goes into a throwaway thread (子区) created in `beforeAll`
 *     and deleted in `afterAll`. It never DMs a human and never posts to the
 *     main group timeline.
 *
 * To run:  `source /path/to/octo.env && npm run test:live`
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  registerBot,
  sendMessage,
  sendReadReceipt,
  sendCardMessage,
  getUploadCredentials,
  getUploadPresign,
  uploadFileToPresignedUrl,
  createThread,
  deleteThread,
} from '../../octo/api.js';
import { WKSocket } from '../../octo/socket.js';
import { ChannelType, MessageType } from '../../octo/types.js';
import type { BotMessage } from '../../octo/types.js';
import { THREAD_ID_SEPARATOR } from '../../octo/channel-id.js';
import { buildDisplayCard } from '../../card-blocks.js';
import { renderProgressCard } from '../../card-render.js';

// ─── Env + gate ──────────────────────────────────────────────────────────────

const apiUrl = (process.env.OCTO_TEST_API_URL ?? '').replace(/\/+$/, '');
const botToken = process.env.OCTO_TEST_BOT_TOKEN ?? '';
const groupNo = process.env.OCTO_TEST_GROUP_ID ?? '';

type RegisterResult = Awaited<ReturnType<typeof registerBot>>;

const LIVE = !!process.env.OCTO_LIVE;

// Required env, evaluated once. Under OCTO_LIVE=1 an incomplete set must FAIL
// (see the env-completeness test), not silently skip.
const missingEnv = (
  [
    ['OCTO_TEST_API_URL', apiUrl],
    ['OCTO_TEST_BOT_TOKEN', botToken],
    ['OCTO_TEST_GROUP_ID', groupNo],
  ] as const
)
  .filter(([, v]) => !v)
  .map(([k]) => k);

// The skip decision is resolved at module load (collection time) via top-level
// await so `describe.skipIf` gets a concrete boolean. It flips true ONLY for the
// two legitimate cases above.
let skip = false;
let skipReason = '';
let pingLabel = 'not attempted';

if (!LIVE) {
  skip = true;
  skipReason = 'OCTO_LIVE not set — live suite skipped (default npm test / PR CI).';
} else if (missingEnv.length === 0) {
  // Liveness probe: ANY HTTP response (even 404/500) proves the server is
  // reachable → the suite runs. ONLY a network-level failure is a legal skip.
  try {
    const resp = await fetch(`${apiUrl}/v1/ping`, { signal: AbortSignal.timeout(5000) });
    pingLabel = `HTTP ${resp.status}`;
  } catch (err) {
    skip = true;
    skipReason = `octo not reachable at ${apiUrl}/v1/ping (${(err as Error).name}) — skipping (spec-allowed).`;
  }
}
// NOTE: when LIVE && missingEnv.length > 0 we deliberately DO NOT skip and DO NOT
// probe (there is no apiUrl to probe). The suite runs and the env-completeness
// test fails loudly.

if (skip) {
  console.warn(`[octo-live] ${skipReason}`);
} else {
  const envNote = missingEnv.length > 0 ? `, MISSING ENV: ${missingEnv.join(', ')} (suite will FAIL)` : '';
  console.log(`[octo-live] live suite armed (ping ${pingLabel}${envNote}).`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the deadline passes. */
async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, intervalMs = 250): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** Minimal view of WKSocket's private raw `ws`, used only to simulate a drop. */
type WithRawWs = { ws: { close(): void } | null };

// Short heartbeat for the suite so the PING/PONG cycle is observable in seconds
// instead of the production 60s. WKSocket honours `heartbeatIntervalMs`.
const HEARTBEAT_MS = 3000;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(skip)('octo live roundtrip', () => {
  // Shared, connected socket reused across the WS-dependent tests.
  let socket: WKSocket | undefined;
  const received: BotMessage[] = [];
  let connectCount = 0;
  let disconnectCount = 0;
  let pongCount = 0;

  // Set by the register-roundtrip test; the shared WS reuses it. Register is done
  // inside a test (not at module load) so a failing handshake surfaces as a real
  // test failure rather than a swallowed skip.
  let sharedReg: RegisterResult | undefined;

  // Isolated throwaway thread.
  let threadShortId = '';
  let threadChannelId = '';

  // The shared WS is connected LAZILY (first WS test), NOT in beforeAll. The
  // server kicks an existing connection whenever the bot re-registers ("Kicked
  // by server" — verified live), so the socket must come up only AFTER the
  // register-roundtrip test has made its registerBot call.
  async function ensureConnected(): Promise<void> {
    if (socket) return;
    if (!sharedReg) {
      throw new Error('register did not succeed — cannot open WS (see the register-roundtrip test)');
    }
    socket = new WKSocket({
      wsUrl: sharedReg.ws_url,
      uid: sharedReg.robot_id,
      token: sharedReg.im_token,
      heartbeatIntervalMs: HEARTBEAT_MS,
      onMessage: (m) => received.push(m),
      onConnected: () => {
        connectCount += 1;
      },
      onDisconnected: () => {
        disconnectCount += 1;
      },
      onPong: () => {
        pongCount += 1;
      },
    });
    socket.connect();
    const up = await waitFor(() => (connectCount > 0 ? true : undefined), 15_000);
    if (!up) throw new Error('WS did not connect within 15s');
  }

  beforeAll(async () => {
    // Nothing to set up if env is incomplete — the env-completeness test is the
    // clean failure signal; skipping the thread create just avoids a noisier
    // hook error on top of it.
    if (missingEnv.length > 0) return;

    // Isolated 子区 so nothing lands on the main group timeline. Uniquely named
    // per run; deleted in afterAll. (No socket / no register here — see
    // ensureConnected above for why the WS is deferred.)
    const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const thread = await createThread({
      apiUrl,
      botToken,
      groupNo,
      name: `cc-live-test ${suffix}`,
    });
    if (!thread?.short_id) {
      throw new Error('createThread returned no short_id — cannot isolate test messages');
    }
    threadShortId = thread.short_id;
    threadChannelId = `${groupNo}${THREAD_ID_SEPARATOR}${threadShortId}`;
  }, 40_000);

  afterAll(async () => {
    try {
      await socket?.disconnectAndWait(3000);
    } catch {
      /* best effort */
    }
    // Clean up the throwaway thread. Best-effort: a leaked empty thread is
    // harmless, and we never want cleanup noise to fail the suite.
    if (threadShortId) {
      try {
        await deleteThread({ apiUrl, botToken, groupNo, shortId: threadShortId });
      } catch {
        /* best effort */
      }
    }
  }, 20_000);

  it('OCTO_LIVE=1 provides every required env var (missing env fails, never skips)', () => {
    expect(missingEnv, `missing required env: ${missingEnv.join(', ') || '(none)'}`).toEqual([]);
  });

  it('register roundtrip returns all six identity fields', async () => {
    const reg = await registerBot({ apiUrl, botToken });
    // Reused by the shared WS. Set before assertions so a later field assertion
    // failing does not also break the WS tests' connect path.
    sharedReg = reg;
    for (const field of [
      'robot_id',
      'im_token',
      'ws_url',
      'api_url',
      'owner_uid',
      'owner_channel_id',
    ] as const) {
      expect(typeof reg[field], `field ${field}`).toBe('string');
      expect(reg[field].length, `field ${field} non-empty`).toBeGreaterThan(0);
    }
    // ws_url must be a WebSocket scheme the client will actually dial.
    expect(reg.ws_url).toMatch(/^wss?:\/\//);
  }, 20_000);

  it('WS heartbeat completes a real PING/PONG cycle and stays connected', async () => {
    await ensureConnected();
    expect(connectCount).toBeGreaterThan(0);
    const beforeDisc = disconnectCount;
    const beforePong = pongCount;
    // The suite sets a HEARTBEAT_MS heartbeat, so the client actually sends a
    // PING and the server replies PONG within seconds (onPong increments
    // pongCount). Wait for a FRESH pong during this window — proves the
    // keep-alive round-trips, not merely that we connected. Budget covers a few
    // heartbeat periods plus slack.
    const gotPong = await waitFor(() => (pongCount > beforePong ? true : undefined), HEARTBEAT_MS * 3 + 8000);
    expect(gotPong, 'observed a server PONG (heartbeat round-trip)').toBe(true);
    // And the link must not have dropped while we watched.
    expect(disconnectCount, 'no drop during the heartbeat window').toBe(beforeDisc);
  }, 30_000);

  it('sends a plain message and receives it back over WS (message_id matches)', async () => {
    await ensureConnected();
    const marker = `live-roundtrip ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await sendMessage({
      apiUrl,
      botToken,
      channelId: threadChannelId,
      channelType: ChannelType.CommunityTopic,
      content: marker,
    });
    expect(result?.message_id, 'sendMessage returned a message_id').toBeTruthy();
    const sentId = result!.message_id;

    // The WS layer intentionally discards clientMsgNo (socket.ts parses it as
    // "unused"), so we correlate on the server-assigned message_id — which both
    // sendMessage's result and the WS BotMessage carry. Content is asserted as a
    // second, human-readable check.
    const echoed = await waitFor(() => received.find((m) => m.message_id === sentId), 15_000);
    expect(echoed, 'WS delivered the just-sent message back').toBeDefined();
    expect(echoed?.payload?.content).toBe(marker);
  }, 30_000);

  it('sends a read receipt', async () => {
    // No message_ids → just clears the conversation unread badge; the call
    // succeeding (no throw) is the assertion.
    await expect(
      sendReadReceipt({
        apiUrl,
        botToken,
        channelId: threadChannelId,
        channelType: ChannelType.CommunityTopic,
        messageIds: [],
      }),
    ).resolves.toBeUndefined();
  }, 15_000);

  it('sends A3 display + A6 progress cards; both round-trip as InteractiveCard', async () => {
    await ensureConnected();

    // A3 — display card built through the merged card path (card-blocks).
    const display = buildDisplayCard({
      title: 'cc-live-test display card',
      blocks: [
        { type: 'text', text: 'live A3 display card body' },
        { type: 'facts', items: [{ label: 'suite', value: 'octo-roundtrip.live' }] },
      ],
    });
    const displayRes = await sendCardMessage({
      apiUrl,
      botToken,
      channelId: threadChannelId,
      channelType: ChannelType.CommunityTopic,
      card: display.card,
      plain: display.plain,
    });
    expect(displayRes?.message_id, 'A3 display card accepted').toBeTruthy();

    // A6 — progress card built through the progress renderer.
    const progress = renderProgressCard({
      phase: 'tool',
      steps: [
        { tool: 'read', status: 'done', durationMs: 12, summary: 'src/octo/api.ts' },
        { tool: 'exec', status: 'running', summary: 'npm run test:live' },
      ],
      elapsedMs: 1234,
    });
    const progressRes = await sendCardMessage({
      apiUrl,
      botToken,
      channelId: threadChannelId,
      channelType: ChannelType.CommunityTopic,
      card: progress.card,
      plain: progress.plain,
    });
    expect(progressRes?.message_id, 'A6 progress card accepted').toBeTruthy();

    // Both cards MUST come back over WS as InteractiveCard(17) carrying an
    // Adaptive Card body — asserted INDEPENDENTLY per card (no "either one is
    // enough", no "silence passes"). Correlated on each card's own message_id.
    const a3 = await waitFor(() => received.find((m) => m.message_id === displayRes!.message_id), 15_000);
    expect(a3, 'A3 display card echoed over WS').toBeDefined();
    expect(a3!.payload?.type, 'A3 is InteractiveCard(17)').toBe(MessageType.InteractiveCard);
    const a3Card = a3!.payload?.card as { body?: unknown } | undefined;
    expect(Array.isArray(a3Card?.body), 'A3 carries an Adaptive Card body[]').toBe(true);

    const a6 = await waitFor(() => received.find((m) => m.message_id === progressRes!.message_id), 15_000);
    expect(a6, 'A6 progress card echoed over WS').toBeDefined();
    expect(a6!.payload?.type, 'A6 is InteractiveCard(17)').toBe(MessageType.InteractiveCard);
    const a6Card = a6!.payload?.card as { body?: unknown; metadata?: unknown } | undefined;
    expect(Array.isArray(a6Card?.body), 'A6 carries an Adaptive Card body[]').toBe(true);
    // The progress renderer emits an agent_progress metadata block — its presence
    // proves the A6 layout survived the round-trip (and is not conflated with A3).
    expect(a6Card?.metadata, 'A6 progress card carries progress metadata').toBeTruthy();
  }, 40_000);

  it('gets upload credentials and PUT-uploads via a presigned URL', async () => {
    // (a) Temp credentials path: shape must be complete.
    const creds = await getUploadCredentials({ apiUrl, botToken, filename: 'cc-live-test.txt' });
    expect(creds.bucket).toBeTruthy();
    expect(creds.region).toBeTruthy();
    expect(creds.key).toBeTruthy();
    expect(creds.credentials.tmpSecretId).toBeTruthy();
    expect(creds.credentials.tmpSecretKey).toBeTruthy();
    expect(creds.credentials.sessionToken).toBeTruthy();

    // (b) Actual PUT upload — the adapter's real outbound path (media-outbound
    // uses presign + PUT). Uploading a few bytes and getting back a downloadUrl
    // proves the credential can actually write.
    const body = Buffer.from(`cc-live-test upload ${Date.now()}`, 'utf-8');
    const presign = await getUploadPresign({
      apiUrl,
      botToken,
      filename: 'cc-live-test.txt',
      fileSize: body.byteLength,
      contentType: 'text/plain',
    });
    expect(presign.uploadUrl).toMatch(/^https?:\/\//);

    const { url } = await uploadFileToPresignedUrl({
      uploadUrl: presign.uploadUrl,
      downloadUrl: presign.downloadUrl,
      fileBody: body,
      fileSize: body.byteLength,
      contentType: presign.contentType,
      contentDisposition: presign.contentDisposition,
    });
    expect(url).toBe(presign.downloadUrl);
  }, 40_000);

  it('auto-reconnects after an unexpected drop and still receives (RECVACK)', async () => {
    await ensureConnected();
    const beforeConnects = connectCount;

    // Simulate an unexpected drop by closing the underlying socket directly.
    // Unlike disconnect(), this leaves needReconnect=true, so the close handler
    // schedules a reconnect (base 3s + jitter).
    const raw = socket as unknown as WithRawWs;
    expect(raw.ws, 'raw ws present before forced drop').toBeTruthy();
    raw.ws?.close();

    const reconnected = await waitFor(
      () => (connectCount > beforeConnects ? true : undefined),
      25_000,
    );
    expect(reconnected, 'WS auto-reconnected after the forced drop').toBe(true);

    // RECVACK path: after reconnect the socket must still receive + ack a fresh
    // message. Receiving it back proves the post-reconnect handshake/decrypt/ack
    // loop is healthy.
    const marker = `live-reconnect ${Date.now().toString(36)}`;
    const result = await sendMessage({
      apiUrl,
      botToken,
      channelId: threadChannelId,
      channelType: ChannelType.CommunityTopic,
      content: marker,
    });
    expect(result?.message_id).toBeTruthy();
    const echoed = await waitFor(() => received.find((m) => m.message_id === result!.message_id), 15_000);
    expect(echoed, 'received a message after reconnect').toBeDefined();
  }, 60_000);
});
