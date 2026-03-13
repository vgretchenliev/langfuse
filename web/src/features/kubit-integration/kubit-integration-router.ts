import { z } from "zod/v4";

import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { encrypt } from "@langfuse/shared/encryption";
import { kubitIntegrationFormSchema } from "@/src/features/kubit-integration/types";
import { TRPCError } from "@trpc/server";
import { env } from "@/src/env.mjs";

export const kubitIntegrationRouter = createTRPCRouter({
  get: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "integrations:CRUD",
      });
      try {
        const dbConfig = await ctx.prisma.kubitIntegration.findFirst({
          where: { projectId: input.projectId },
        });

        if (!dbConfig) return null;

        return {
          projectId: dbConfig.projectId,
          endpointUrl: dbConfig.endpointUrl,
          enabled: dbConfig.enabled,
          syncIntervalMinutes: dbConfig.syncIntervalMinutes,
          sessionOffsetMinutes: dbConfig.sessionOffsetMinutes,
          requestTimeoutSeconds: dbConfig.requestTimeoutSeconds,
          lastSyncAt: dbConfig.lastSyncAt,
          createdAt: dbConfig.createdAt,
        };
      } catch (e) {
        console.error("kubit integration get", e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),

  update: protectedProjectProcedure
    .input(kubitIntegrationFormSchema.extend({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "integrations:CRUD",
      });

      if (!env.ENCRYPTION_KEY) {
        if (env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
          });
        } else {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Missing environment variable: `ENCRYPTION_KEY`. Please consult our docs: https://langfuse.com/self-hosting",
          });
        }
      }

      await auditLog({
        session: ctx.session,
        action: "update",
        resourceType: "kubitIntegration",
        resourceId: input.projectId,
      });

      const existing = await ctx.prisma.kubitIntegration.findFirst({
        where: { projectId: input.projectId },
      });

      // API key is required when creating the integration for the first time
      if (!existing && !input.apiKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "API key is required to enable the integration",
        });
      }

      const sharedData = {
        endpointUrl: input.endpointUrl,
        enabled: input.enabled,
        syncIntervalMinutes: input.syncIntervalMinutes,
        sessionOffsetMinutes: input.sessionOffsetMinutes,
        requestTimeoutSeconds: input.requestTimeoutSeconds,
        // Only update the API key if a new one is provided
        ...(input.apiKey ? { encryptedApiKey: encrypt(input.apiKey) } : {}),
      };

      if (existing) {
        await ctx.prisma.kubitIntegration.update({
          where: { projectId: input.projectId },
          data: sharedData,
        });
      } else {
        await ctx.prisma.kubitIntegration.create({
          data: {
            projectId: input.projectId,
            encryptedApiKey: encrypt(input.apiKey),
            ...sharedData,
          },
        });
      }
    }),

  delete: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "integrations:CRUD",
        });
        await auditLog({
          session: ctx.session,
          action: "delete",
          resourceType: "kubitIntegration",
          resourceId: input.projectId,
        });
        await ctx.prisma.kubitIntegration.delete({
          where: { projectId: input.projectId },
        });
      } catch (e) {
        console.error("kubit integration delete", e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      }
    }),
});
