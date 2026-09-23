import { z } from 'zod';

export const IntentType = ['chat', 'image_generation', 'video_generation', 'image_analysis', 'file_analysis', 'agent_task', 'workflow'] as const;

export const TaskIntentSchema = z.object({
  type: z.enum(IntentType),
  confidence: z.number().min(0).max(1),
  parameters: z.object({
    prompt: z.string().min(1),
    aspectRatio: z.string().optional(),
    duration: z.number().positive().optional(),
    referenceMessageId: z.string().uuid().optional(),
  }),
  agent: z.string().optional(),
});
export type TaskIntent = z.infer<typeof TaskIntentSchema>;
