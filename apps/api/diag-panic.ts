import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(process.cwd(), '../../.env') });
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

(async () => {
  const tests: Array<[string, () => Promise<unknown>]> = [
    ['prov-openai-plain', () => p.provider.findUnique({ where: { id: 'seed-llm-OpenAI' } })],
    ['prov-openai-models', () => p.provider.findUnique({ where: { id: 'seed-llm-OpenAI' }, include: { models: true } })],
    ['model-openai-plain', () => p.model.findUnique({ where: { id: 'seed-model-seed-llm-OpenAI-gpt-4o-mini' } })],
    ['model-deepseek-prov', () => p.model.findUnique({ where: { id: 'seed-model-seed-llm-DeepSeek-deepseek-chat' }, include: { provider: true } })],
    ['model-openai-min-select', () => p.model.findUnique({ where: { id: 'seed-model-seed-llm-OpenAI-gpt-4o-mini' }, include: { provider: { select: {} } } })],
  ];
  for (const [label, q] of tests) {
    try { await q(); console.log(label, 'OK'); }
    catch { console.log(label, 'PANIC'); }
  }
  await p.$disconnect();
})();
