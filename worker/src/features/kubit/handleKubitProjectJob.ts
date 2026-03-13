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
import { decrypt } from "@langfuse/shared/encryption";
import { KubitClient } from "./kubitClient";

type KubitConfig = {
  projectId: string;
  apiKey: string;
  minTimestamp: Date;
  maxTimestamp: Date;
  endpointUrl: string;
  requestTimeoutSeconds: number;
};

const processKubitTraces = async (config: KubitConfig) => {
  const traces = getTracesForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    endpointUrl: config.endpointUrl,
    apiKey: config.apiKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  for await (const trace of traces) {
    count++;
    client.addEvent(trace);
    if (count % 1000 === 0) {
      await client.flush();
      logger.info(
        `[KUBIT] Sent ${count} traces for project ${config.projectId}`,
      );
    }
  }

  await client.flush();
  logger.info(`[KUBIT] Sent ${count} traces for project ${config.projectId}`);
};

const processKubitObservations = async (config: KubitConfig) => {
  const observations = getObservationsForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    endpointUrl: config.endpointUrl,
    apiKey: config.apiKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  for await (const observation of observations) {
    count++;
    client.addEvent(observation);
    if (count % 1000 === 0) {
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
};

const processKubitScores = async (config: KubitConfig) => {
  const scores = getScoresForKubit(
    config.projectId,
    config.minTimestamp,
    config.maxTimestamp,
  );

  const client = new KubitClient({
    endpointUrl: config.endpointUrl,
    apiKey: config.apiKey,
    requestTimeoutSeconds: config.requestTimeoutSeconds,
  });
  let count = 0;

  for await (const score of scores) {
    count++;
    client.addEvent(score);
    if (count % 1000 === 0) {
      await client.flush();
      logger.info(
        `[KUBIT] Sent ${count} scores for project ${config.projectId}`,
      );
    }
  }

  await client.flush();
  logger.info(`[KUBIT] Sent ${count} scores for project ${config.projectId}`);
};

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

  const config: KubitConfig = {
    projectId,
    apiKey: decrypt(dbIntegration.encryptedApiKey),
    minTimestamp: dbIntegration.lastSyncAt ?? new Date("2000-01-01"),
    maxTimestamp: new Date(
      new Date().getTime() - dbIntegration.sessionOffsetMinutes * 60 * 1000,
    ),
    endpointUrl: dbIntegration.endpointUrl,
    requestTimeoutSeconds: dbIntegration.requestTimeoutSeconds,
  };

  try {
    await Promise.all([
      processKubitTraces(config),
      processKubitObservations(config),
      processKubitScores(config),
    ]);

    await prisma.kubitIntegration.update({
      where: { projectId },
      data: { lastSyncAt: config.maxTimestamp },
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
