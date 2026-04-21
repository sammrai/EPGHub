import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { createApp, DOC_META } from '../src/app.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'openapi.yaml');

const app = createApp();
const doc = app.getOpenAPI31Document(DOC_META);

writeFileSync(outPath, stringify(doc));
console.log(`wrote ${outPath}`);
