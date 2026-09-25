import { z } from 'zod';

export const CreateOrganizationSchema = z.strictObject({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]{3,50}$/).optional(),
});

export const UpdateOrganizationSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
});

export const InviteSchema = z.strictObject({
  email: z.string().email().max(200),
  role: z.enum(['admin', 'member', 'viewer']).optional(),
});

export const AcceptInvitationSchema = z.strictObject({
  token: z.string().min(16).max(128),
});
