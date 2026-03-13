-- CreateTable
CREATE TABLE "kubit_integrations" (
    "project_id" TEXT NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 60,
    "session_offset_minutes" INTEGER NOT NULL DEFAULT 30,
    "request_timeout_seconds" INTEGER NOT NULL DEFAULT 30,
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kubit_integrations_pkey" PRIMARY KEY ("project_id")
);

-- AddForeignKey
ALTER TABLE "kubit_integrations" ADD CONSTRAINT "kubit_integrations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
