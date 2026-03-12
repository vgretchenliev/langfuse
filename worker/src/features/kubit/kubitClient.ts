import { logger } from "@langfuse/shared/src/server";

type KubitEvent = Record<string, unknown> & { entity_type: string };

export class KubitClient {
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private batch: KubitEvent[] = [];
  private readonly batchSize = 1000;

  constructor({
    endpointUrl,
    apiKey,
  }: {
    endpointUrl: string;
    apiKey: string;
  }) {
    this.endpointUrl = endpointUrl;
    this.apiKey = apiKey;
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
      await this.sendBatch(chunk);
    }

    this.batch = [];
  }

  private async sendBatch(events: KubitEvent[]): Promise<void> {
    const response = await fetch(this.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ events }),
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
  }

  public getBatchSize(): number {
    return this.batch.length;
  }
}
