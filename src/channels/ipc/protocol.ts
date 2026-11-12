import { z } from "zod";

export const notificationSchema = z.strictObject({
  eventKey: z.string().trim().min(1),
  message: z.string().trim().min(1),
  data: z.json().default(null),
});
export const receiptSchema = z.strictObject({
  status: z.enum(["accepted", "duplicate"]),
  notificationId: z.int().positive(),
});
