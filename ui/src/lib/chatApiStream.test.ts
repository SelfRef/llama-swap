import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatCompletion } from "./chatApi";

/** A streamed response body carrying the given SSE lines. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const rejection = { ok: false, status: 400, text: async () => "unknown field timings_per_token" } as Response;

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

async function collect(model = "m") {
  const out = [];
  for await (const chunk of streamChatCompletion(model, [{ role: "user", content: "hi" }])) out.push(chunk);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("streamChatCompletion", () => {
  it("asks for per-chunk timings and streams the reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([`data: {"choices":[{"delta":{"content":"hi"}}]}`, "data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    const chunks = await collect();

    expect(bodyOf(fetchMock.mock.calls[0]).timings_per_token).toBe(true);
    expect(chunks[0]).toMatchObject({ content: "hi" });
  });

  // A backend that validates its request body rejects the llama.cpp
  // extension; the turn must still go through, and later turns must not pay
  // for the rejection again.
  it("retries without the extension when the backend rejects it, then stops sending it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejection)
      .mockResolvedValue(sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}`, "data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    expect((await collect()).some((c) => c.content === "ok")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0])).toHaveProperty("timings_per_token");
    expect(bodyOf(fetchMock.mock.calls[1])).not.toHaveProperty("timings_per_token");

    await collect();
    expect(fetchMock).toHaveBeenCalledTimes(3); // one request, no retry
    expect(bodyOf(fetchMock.mock.calls[2])).not.toHaveProperty("timings_per_token");
  });

  // Ordered after the test above on purpose: the session has given up on the
  // extension, so a 400 now is a real error and must surface.
  it("reports a 400 that is not about the extension", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad model" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect()).rejects.toThrow(/400 - bad model/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
