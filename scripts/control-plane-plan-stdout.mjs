// Release builds embed this plan in the ingestion image; hosts apply it with psql.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readControlPlanePlan } from './control-plane-plan.mjs';

const { statement } = await readControlPlanePlan(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);
process.stdout.write(statement + '\n');
