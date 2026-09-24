-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_modelId_fkey";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "config",
DROP COLUMN "maxTokens",
DROP COLUMN "modelId",
DROP COLUMN "systemPrompt",
DROP COLUMN "temperature",
DROP COLUMN "tools",
DROP COLUMN "version";

