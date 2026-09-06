/**
 * D3 / D1 hard gate #2 belt: stream-relay.deliver must FAIL LOUD if it is ever
 * handed a doc-task sentinel channel — the doc-task fork in handleMessage should
 * have routed the reply to the comment thread, never IM. This is the last line
 * if a future refactor drops the fork; it must not silently sendMessage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMessage = vi.fn();
const sendTyping = vi.fn();
vi.mock("../octo/api.js", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendTyping: (...a: unknown[]) => sendTyping(...a),
}));

import { StreamRelay } from "../stream-relay.js";
import { ChannelType } from "../octo/types.js";
import { DOC_TASK_NON_ROUTABLE_PREFIX } from "../doc-task-scope.js";

async function* one(): AsyncIterable<string> {
  yield "leaked document content";
}

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  sendTyping.mockReset().mockResolvedValue(undefined);
});

describe("stream-relay doc-task belt", () => {
  it("throws on a sentinel channel and emits NO message / typing", async () => {
    const relay = new StreamRelay();
    const sentinel = `${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`;
    await expect(
      relay.deliver(sentinel, ChannelType.DM, one(), "https://x", "t"),
    ).rejects.toThrow(/document-task session|comment thread/i);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("negative control: a normal channel delivers as usual", async () => {
    const relay = new StreamRelay();
    await relay.deliver("g1", ChannelType.Group, one(), "https://x", "t");
    expect(sendMessage).toHaveBeenCalled();
  });
});
