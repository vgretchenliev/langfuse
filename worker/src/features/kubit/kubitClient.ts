import { logger } from "@langfuse/shared/src/server";

type KubitEvent = Record<string, unknown> & { entity_type: string };

const MAX_RETRIES = 3;
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // 8 MB — 2 MB safety margin below API Gateway's 10 MB hard limit

export class KubitClient {
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private batch: KubitEvent[] = [];

  constructor({
    endpointUrl,
    apiKey,
    requestTimeoutSeconds,
  }: {
    endpointUrl: string;
    apiKey: string;
    requestTimeoutSeconds: number;
  }) {
    this.endpointUrl = endpointUrl;
    this.apiKey = apiKey;
    this.requestTimeoutMs = requestTimeoutSeconds * 1000;
  }

  public addEvent(event: KubitEvent): void {
    this.batch.push(event);
  }

  public async flush(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const chunks: KubitEvent[][] = [];
    let currentChunk: KubitEvent[] = [];
    let currentChunkBytes = 0;

    for (const event of this.batch) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (
        currentChunk.length > 0 &&
        currentChunkBytes + eventBytes > MAX_BATCH_BYTES
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkBytes = 0;
      }
      currentChunk.push(event);
      currentChunkBytes += eventBytes;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    for (const chunk of chunks) {
      await this.sendBatchWithRetry(chunk);
    }

    this.batch = [];
  }

  private async sendBatchWithRetry(events: KubitEvent[]): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendBatch(events);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delayMs = 1000 * Math.pow(2, attempt - 1);
          logger.warn(
            `[KUBIT] Attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms`,
            { error: lastError.message },
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError;
  }

  private async sendBatch(events: KubitEvent[]): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );

    try {
      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          `[KUBIT] Failed to send events: ${response.status} ${response.statusText}`,
          { body: errorText },
        );
        throw new Error(
          `Kubit API error: ${response.status} ${response.statusText}`,
        );
      }

      logger.debug("[KUBIT] Successfully sent batch", { count: events.length });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public getBatchSize(): number {
    return this.batch.length;
  }
}
