/*
  Warnings:

  - You are about to drop the column `secretHash` on the `WorkflowWebhook` table. All the data in the column will be lost.
  - Added the required column `secretEncrypted` to the `WorkflowWebhook` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "workflowRunId" TEXT;

-- AlterTable
ALTER TABLE "WorkflowWebhook" DROP COLUMN "secretHash",
ADD COLUMN     "secretEncrypted" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Approval_workflowRunId_idx" ON "Approval"("workflowRunId");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
