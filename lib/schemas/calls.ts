import { z } from "zod";

export const createCallSchema = z.object({
  toNumber: z.string().min(8),
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  mode: z.enum(["ai", "human"]).default("ai"),
});
