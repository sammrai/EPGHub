import { z } from '@hono/zod-openapi';

export const GenreSchema = z
  .object({
    key: z.string().openapi({ example: 'drama' }),
    label: z.string().openapi({ example: 'ドラマ' }),
    dot: z.string().openapi({ example: 'oklch(0.62 0.12 20)', description: 'UI 表示色' }),
  })
  .openapi('Genre');

export type Genre = z.infer<typeof GenreSchema>;
