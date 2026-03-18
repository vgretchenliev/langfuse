import { Job } from "bullmq";
import {
  QueueName,
  TQueueJobTypes,
  logger,
  getCurrentSpan,
  getTracesForKubit,
  getObservationsForKubit,
  getScoresForKubit,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { decrypt, encrypt } from "@langfuse/shared/encryption";
import { KubitClient } from "./kubitClient";
import { z } from "zod/v4";

// ── Token endpoint ──

const tokenResponseSchema = z.object({
  credentials: z.object({
    AccessKeyId: z.string(),
    SecretAccessKey: z.string(),
    SessionToken: z.string(),
  }),
  metadata: z.object({
    partition_key: z.string(),
    stream_name: z.string(),
    region: z.string(),
    expiry: z.string(),
  }),
});

type AwsCredentials = {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  awsKinesisRegion: string;
  awsKinesisStreamName: string;
  awsKinesisPartitionKey: string;
};

async function getOrRefreshAwsCredentials(params: {
  dbIntegration: {
    endpointUrl: string;
    encryptedApiKey: string;
    encryptedAwsAccessKeyId: string | null;
    encryptedAwsSecretAccessKey: string | null;
    encryptedAwsSessionToken: string | null;
    awsCredentialsExpiry: Date | null;
    awsKinesisStreamName: string | null;
    awsKinesisRegion: string | null;
    awsKinesisPartitionKey: string | null;
    projectId: string;
  };
}): Promise<AwsCredentials | undefined> {
  const { dbIntegration } = params;

  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  const credentialsValid =
    dbIntegration.awsCredentialsExpiry !== null &&
    dbIntegration.awsCredentialsExpiry > fiveMinutesFromNow &&
    dbIntegration.encryptedAwsAccessKeyId !== null &&
    dbIntegration.encryptedAwsSecretAccessKey !== null &&
    dbIntegration.encryptedAwsSessionToken !== null &&
    dbIntegration.awsKinesisStreamName !== null &&
    dbIntegration.awsKinesisRegion !== null &&
    dbIntegration.awsKinesisPartitionKey !== null;

  if (credentialsValid) {
    return {
      awsAccessKeyId: decrypt(dbIntegration.encryptedAwsAccessKeyId!),
      awsSecretAccessKey: decrypt(dbIntegration.encryptedAwsSecretAccessKey!),
      awsSessionToken: decrypt(dbIntegration.encryptedAwsSessionToken!),
      awsKinesisRegion: dbIntegration.awsKinesisRegion!,
      awsKinesisStreamName: dbIntegration.awsKinesisStreamName!,
      awsKinesisPartitionKey: dbIntegration.awsKinesisPartitionKey!,
    };
  }

  logger.info(
    `[KUBIT] Refreshing AWS credentials for project ${dbIntegration.projectId}`,
  );

  const tokenUrl = `${dbIntegration.endpointUrl}/token`;
  const apiKey = decrypt(dbIntegration.encryptedApiKey);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Token endpoint returned ${response.status}: ${errorText}`;

    if (response.status === 401 || response.status === 403) {
      // Permanent auth failure — disable the integration so the scheduler
      // stops retrying until the user fixes the API key.
      await prisma.kubitIntegration.update({
        where: { projectId: dbIntegration.projectId },
        data: { enabled: false, lastError: message },
      });
      logger.error(
        `[KUBIT] Disabling integration for project ${dbIntegration.projectId} — ${message}`,
      );
      // Return undefined to signal a permanent failure without throwing,
      // so BullMQ does not retry the job.
      return undefined;
    }

    throw new Error(`[KUBIT] ${message}`);
  }

  const raw = await response.json();
  const parsed = tokenResponseSchema.parse(raw);

  await prisma.kubitIntegration.update({
    where: { projectId: dbIntegration.projectId },
    data: {
      encryptedAwsAccessKeyId: encrypt(parsed.credentials.AccessKeyId),
      encryptedAwsSecretAccessKey: encrypt(parsed.credentials.SecretAccessKey),
      encryptedAwsSessionToken: encrypt(parsed.credentials.SessionToken),
      awsCredentialsExpiry: new Date(parsed.metadata.expiry),
      awsKinesisStreamName: parsed.metadata.stream_name,
      awsKinesisRegion: parsed.metadata.region,
      awsKinesisPartitionKey: parsed.metadata.partition_key,
    },
  });

  logger.info(
    `[KUBIT] AWS credentials refreshed for project ${dbIntegration.projectId}`,
    { expiry: parsed.metadata.expiry, region: parsed.metadata.region },
  );

  return {
    awsAccessKeyId: parsed.credentials.AccessKeyId,
    awsSecretAccessKey: parsed.credentials.SecretAccessKey,
    awsSessionToken: parsed.credentials.SessionToken,
    awsKinesisRegion: parsed.metadata.region,
    awsKinesisStreamName: parsed.metadata.stream_name,
    awsKinesisPartitionKey: parsed.metadata.partition_key,
  };
}

// ── Job config ──

type KubitConfig = {
  projectId: string;
  minTimestamp: Date;
  maxTimestamp: Date;
  requestTimeoutSeconds: number;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
  awsKinesisRegion: string;
  awsKinesisStreamName: string;
  awsKinesisPartitionKey: string;
};

// ── Processors ──

const processKubitTraces = async (config: KubitConfig) => {
  const traces = getTracesForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    awsAccessKeyId: config.awsAccessKeyId,
    awsSecretAccessKey: config.awsSecretAccessKey,
    awsSessionToken: config.awsSessionToken,
    awsRegion: config.awsKinesisRegion,
    streamName: config.awsKinesisStreamName,
    projectId: config.projectId,
    workspaceId: config.awsKinesisPartitionKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  try {
    for await (const trace of traces) {
      count++;
      client.addEvent(trace);
      if (client.shouldFlush()) {
        await client.flush();
        logger.info(
          `[KUBIT] Sent ${count} traces for project ${config.projectId}`,
        );
      }
    }

    await client.flush();
    logger.info(`[KUBIT] Sent ${count} traces for project ${config.projectId}`);
  } finally {
    await client.destroy();
  }
};

const processKubitObservations = async (config: KubitConfig) => {
  const observations = getObservationsForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    awsAccessKeyId: config.awsAccessKeyId,
    awsSecretAccessKey: config.awsSecretAccessKey,
    awsSessionToken: config.awsSessionToken,
    awsRegion: config.awsKinesisRegion,
    streamName: config.awsKinesisStreamName,
    projectId: config.projectId,
    workspaceId: config.awsKinesisPartitionKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  try {
    for await (const observation of observations) {
      count++;
      client.addEvent(observation);
      if (client.shouldFlush()) {
        await client.flush();
        logger.info(
          `[KUBIT] Sent ${count} observations for project ${config.projectId}`,
        );
      }
    }

    await client.flush();
    logger.info(
      `[KUBIT] Sent ${count} observations for project ${config.projectId}`,
    );
  } finally {
    await client.destroy();
  }
};

const processKubitScores = async (config: KubitConfig) => {
  const scores = getScoresForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    awsAccessKeyId: config.awsAccessKeyId,
    awsSecretAccessKey: config.awsSecretAccessKey,
    awsSessionToken: config.awsSessionToken,
    awsRegion: config.awsKinesisRegion,
    streamName: config.awsKinesisStreamName,
    projectId: config.projectId,
    workspaceId: config.awsKinesisPartitionKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  try {
    for await (const score of scores) {
      count++;
      client.addEvent(score);
      if (client.shouldFlush()) {
        await client.flush();
        logger.info(
          `[KUBIT] Sent ${count} scores for project ${config.projectId}`,
        );
      }
    }

    await client.flush();
    logger.info(`[KUBIT] Sent ${count} scores for project ${config.projectId}`);
  } finally {
    await client.destroy();
  }
};

// ── Main job handler ──

export const handleKubitProjectJob = async (
  job: Job<TQueueJobTypes[QueueName.KubitIntegrationProcessingQueue]>,
) => {
  const { projectId } = job.data.payload;

  const span = getCurrentSpan();
  if (span) {
    span.setAttribute("messaging.bullmq.job.input.jobId", job.data.id);
    span.setAttribute("messaging.bullmq.job.input.projectId", projectId);
  }

  const dbIntegration = await prisma.kubitIntegration.findFirst({
    where: { projectId, enabled: true },
  });

  if (!dbIntegration) {
    logger.info(
      `[KUBIT] No enabled Kubit integration for project ${projectId}, skipping`,
    );
    return;
  }

  logger.info(`[KUBIT] Processing Kubit integration for project ${projectId}`);

  const awsCredentials = await getOrRefreshAwsCredentials({ dbIntegration });

  // Permanent auth failure — integration has been disabled, nothing left to do.
  if (!awsCredentials) return;

  const config: KubitConfig = {
    projectId,
    minTimestamp: dbIntegration.lastSyncAt ?? new Date("2000-01-01"),
    maxTimestamp: new Date(),
    requestTimeoutSeconds: dbIntegration.requestTimeoutSeconds,
    ...awsCredentials,
  };

  try {
    await Promise.all([
      processKubitTraces(config),
      processKubitObservations(config),
      processKubitScores(config),
    ]);

    await prisma.kubitIntegration.update({
      where: { projectId },
      data: { lastSyncAt: config.maxTimestamp, lastError: null },
    });

    logger.info(`[KUBIT] Kubit integration complete for project ${projectId}`);
  } catch (error) {
    logger.error(
      `[KUBIT] Error processing Kubit integration for project ${projectId}`,
      error,
    );
    throw error;
  }
};
