import { logger } from "@langfuse/shared/src/server";

type KubitEvent = Record<string, unknown> & { entity_type: string };

const MAX_RETRIES = 3;

export class KubitClient {
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private batch: KubitEvent[] = [];
  private readonly batchSize = 1000;

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
    for (let i = 0; i < this.batch.length; i += this.batchSize) {
      chunks.push(this.batch.slice(i, i + this.batchSize));
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
