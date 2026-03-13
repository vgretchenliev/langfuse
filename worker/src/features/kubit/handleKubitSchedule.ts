import { prisma } from "@langfuse/shared/src/db";
import {
  KubitIntegrationProcessingQueue,
  QueueJobs,
  logger,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";

export const handleKubitSchedule = async () => {
  const now = new Date();

  const integrations = await prisma.kubitIntegration.findMany({
    select: {
      projectId: true,
      lastSyncAt: true,
      syncIntervalMinutes: true,
    },
    where: { enabled: true },
  });

  if (integrations.length === 0) {
    logger.info("[KUBIT] No Kubit integrations ready for sync");
    return;
  }

  // Only enqueue projects whose sync interval has elapsed since lastSyncAt
  const due = integrations.filter(({ lastSyncAt, syncIntervalMinutes }) => {
    if (!lastSyncAt) return true; // never synced — always due
    return (
      now.getTime() - lastSyncAt.getTime() >= syncIntervalMinutes * 60 * 1000
    );
  });

  if (due.length === 0) {
    logger.info("[KUBIT] No Kubit integrations due for sync");
    return;
  }

  const processingQueue = KubitIntegrationProcessingQueue.getInstance();
  if (!processingQueue) {
    throw new Error("KubitIntegrationProcessingQueue not initialized");
  }

  logger.info(`[KUBIT] Scheduling ${due.length} projects for Kubit sync`);

  await processingQueue.addBulk(
    due.map(({ projectId, lastSyncAt }) => ({
      name: QueueJobs.KubitIntegrationProcessingJob,
      data: {
        id: randomUUID(),
        name: QueueJobs.KubitIntegrationProcessingJob,
        timestamp: new Date(),
        payload: { projectId },
      },
      opts: {
        jobId: `${projectId}-${lastSyncAt?.toISOString() ?? ""}`,
        removeOnFail: true,
      },
    })),
  );
};
