import { describe, it, expect, vi, beforeEach } from "vitest";
import { KubitClient } from "../features/kubit/kubitClient";

const ENDPOINT = "https://langfuse-ingest.kubit.ai";
const API_KEY = "test-api-key";
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // 8 MB

function makeClient() {
  return new KubitClient({
    endpointUrl: ENDPOINT,
    apiKey: API_KEY,
    requestTimeoutSeconds: 30,
  });
}

function mockFetchOk() {
  const calls: { body: { events: unknown[] }; byteSize: number }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as string;
      calls.push({
        body: JSON.parse(body),
        byteSize: Buffer.byteLength(body, "utf8"),
      });
      return {
        ok: true,
        text: async () => "",
      } as Response;
    }),
  );

  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("KubitClient — size-based batching", () => {
  it("sends a single batch when total payload is under 8 MB", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    // 10 events × ~1 KB each = ~10 KB total
    for (let i = 0; i < 10; i++) {
      client.addEvent({ entity_type: "score", id: `score-${i}`, value: i });
    }

    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.events).toHaveLength(10);
    expect(calls[0].byteSize).toBeLessThan(MAX_BATCH_BYTES);
  });

  it("splits into multiple batches when total payload exceeds 8 MB", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    // Each event ~1 MB (1M chars ≈ 1 MB UTF-8)
    const bigText = "x".repeat(1_000_000);
    for (let i = 0; i < 20; i++) {
      client.addEvent({
        entity_type: "trace",
        id: `trace-${i}`,
        input: bigText,
      });
    }

    await client.flush();

    // 20 MB total → should be split into at least 3 batches of ≤8 MB each
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.byteSize).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }

    // All events accounted for
    const totalEvents = calls.reduce((sum, c) => sum + c.body.events.length, 0);
    expect(totalEvents).toBe(20);
  });

  it("sends correct Authorization header", async () => {
    const sentHeaders: HeadersInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentHeaders.push(init.headers as HeadersInit);
        return { ok: true, text: async () => "" } as Response;
      }),
    );

    const client = makeClient();
    client.addEvent({ entity_type: "score", id: "s1", value: 1 });
    await client.flush();

    expect(sentHeaders[0]).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
    });
  });

  it("does nothing when batch is empty", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    await client.flush();

    expect(calls).toHaveLength(0);
  });

  it("clears the batch after flush", async () => {
    mockFetchOk();
    const client = makeClient();

    client.addEvent({ entity_type: "score", id: "s1", value: 1 });
    await client.flush();

    expect(client.getBatchSize()).toBe(0);
  });
});
