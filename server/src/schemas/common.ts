import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    code: z.string().openapi({ example: 'reserve.conflict' }),
    message: z.string().openapi({ example: '予約時間帯に空きチューナーがありません' }),
    detail: z.record(z.unknown()).optional(),
  })
  .openapi('Error');

export type Error = z.infer<typeof ErrorSchema>;
