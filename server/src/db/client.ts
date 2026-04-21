import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Copy server/.env.example to server/.env and run Postgres.'
  );
}

export const queryClient = postgres(url, { max: 10 });
export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
