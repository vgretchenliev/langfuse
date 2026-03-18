import { describe, it, expect, vi, beforeEach } from "vitest";
import { KubitClient } from "../features/kubit/kubitClient";

const PROJECT_ID = "project-abc-123";
const WORKSPACE_ID = "workspace-xyz-456";

const AWS_CREDS = {
  awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  awsSessionToken: "test-session-token",
  awsRegion: "us-east-1",
  streamName: "langfuse-kubit-events",
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
};

function makeClient() {
  return new KubitClient({
    ...AWS_CREDS,
    requestTimeoutSeconds: 30,
  });
}

/** Decode a single Kinesis record's Data field into the event it carries. */
function decodeRecord(data: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
}

type FetchCall = {
  url: string;
  headers: Record<string, string>;
  body: {
    StreamName: string;
    Records: { Data: string; PartitionKey: string }[];
  };
  bodyBytes: number;
};

function mockFetchOk(): FetchCall[] {
  const calls: FetchCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const bodyStr = init.body as string;
      const parsed = JSON.parse(bodyStr);
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: parsed,
        bodyBytes: Buffer.byteLength(bodyStr, "utf8"),
      });
      return {
        ok: true,
        text: async () => "",
        json: async () => ({
          FailedRecordCount: 0,
          Records: parsed.Records.map(() => ({
            SequenceNumber:
              "49640338859349934440025507667573645222572899765701713922",
            ShardId: "shardId-000000000000",
          })),
        }),
      } as unknown as Response;
    }),
  );

  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("KubitClient — Kinesis PutRecords via REST", () => {
  it("sends one Kinesis record per event in a single PutRecords call for a small batch", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    for (let i = 0; i < 10; i++) {
      client.addEvent({ entity_type: "score", id: `score-${i}`, value: i });
    }

    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.Records).toHaveLength(10);
    expect(calls[0].body.StreamName).toBe(AWS_CREDS.streamName);
    expect(calls[0].url).toBe(
      `https://kinesis.${AWS_CREDS.awsRegion}.amazonaws.com/`,
    );
  });

  it("sets required Kinesis headers including X-Amz-Target and Authorization", async () => {
    const calls = mockFetchOk();
    const client = makeClient();
    client.addEvent({ entity_type: "score", id: "s1", value: 1 });
    await client.flush();

    const headers = calls[0].headers;
    expect(headers["X-Amz-Target"]).toBe("Kinesis_20131202.PutRecords");
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(headers["X-Amz-Security-Token"]).toBe(AWS_CREDS.awsSessionToken);
    expect(headers["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it("base64-encodes each record's Data as a single JSON event", async () => {
    const calls = mockFetchOk();
    const client = makeClient();
    const event = { entity_type: "trace", id: "t1", name: "test" };
    client.addEvent(event);
    await client.flush();

    const record = calls[0].body.Records[0];
    const decoded = decodeRecord(record.Data);
    // Event is enriched with wid (Kubit workspace ID) before encoding
    expect(decoded).toEqual({ ...event, wid: WORKSPACE_ID });
  });

  it("adds wid field (projectId) to every event for dynamic partitioning", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    client.addEvent({ entity_type: "trace", id: "t1" });
    client.addEvent({ entity_type: "observation", id: "o1" });
    client.addEvent({ entity_type: "score", id: "s1" });
    await client.flush();

    for (const record of calls[0].body.Records) {
      const decoded = decodeRecord(record.Data);
      expect(decoded.wid).toBe(WORKSPACE_ID);
    }
  });

  it("uses wid/event.id as the PartitionKey when event.id is a non-empty string", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    client.addEvent({ entity_type: "trace", id: "t1" });
    client.addEvent({ entity_type: "score", id: "s1" });
    await client.flush();

    expect(calls[0].body.Records[0].PartitionKey).toBe(`${WORKSPACE_ID}/t1`);
    expect(calls[0].body.Records[1].PartitionKey).toBe(`${WORKSPACE_ID}/s1`);
  });

  it("falls back to wid/randomUUID as the PartitionKey when event.id is absent or non-string", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    // No id field
    client.addEvent({ entity_type: "trace" });
    // Numeric id
    client.addEvent({ entity_type: "score", id: 42 } as unknown as Parameters<
      typeof client.addEvent
    >[0]);
    // Empty string id
    client.addEvent({ entity_type: "observation", id: "" });
    await client.flush();

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const record of calls[0].body.Records) {
      const [wid, id] = record.PartitionKey.split("/");
      expect(wid).toBe(WORKSPACE_ID);
      expect(uuidRegex.test(id)).toBe(true);
    }
  });

  it("splits into multiple PutRecords calls when records exceed 250 per call", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    for (let i = 0; i < 1100; i++) {
      client.addEvent({ entity_type: "score", id: `score-${i}`, value: i });
    }

    await client.flush();

    // 1100 records → at least 5 PutRecords calls (≤ 250 records each)
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call.body.Records.length).toBeLessThanOrEqual(250);
    }
    const totalRecords = calls.reduce(
      (sum, c) => sum + c.body.Records.length,
      0,
    );
    expect(totalRecords).toBe(1100);
  });

  it("splits into multiple PutRecords calls when payload exceeds 5 MB per call", async () => {
    const calls = mockFetchOk();
    const client = makeClient();

    // ~600 KB each; 10 × ~600 KB = ~6 MB > 5 MB → needs at least 2 PutRecords calls
    const bigText = "x".repeat(600_000);
    for (let i = 0; i < 10; i++) {
      client.addEvent({
        entity_type: "trace",
        id: `trace-${i}`,
        input: bigText,
      });
    }

    await client.flush();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    const totalRecords = calls.reduce(
      (sum, c) => sum + c.body.Records.length,
      0,
    );
    expect(totalRecords).toBe(10);
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

  it("shouldFlush returns false for a small buffer and true once the 25 MB threshold is reached", () => {
    const client = makeClient();

    // Small events — well below 25 MB
    for (let i = 0; i < 10; i++) {
      client.addEvent({ entity_type: "score", id: `s-${i}`, v: i });
    }
    expect(client.shouldFlush()).toBe(false);

    // Add 26 × ~1.05 MB events = ~27.3 MB > 25 MB hard-coded threshold
    const almostOneMb = "x".repeat(1_050_000);
    for (let i = 0; i < 26; i++) {
      client.addEvent({
        entity_type: "trace",
        id: `big-${i}`,
        data: almostOneMb,
      });
    }
    expect(client.shouldFlush()).toBe(true);
  });
});
