#!/usr/bin/env node
// Offline duplicate-POI report over a JSONL data directory (DATA_DIR). Read-only: it only
// prints candidates; decisions are recorded by ops through POST /api/ops/poi-merges.
// For a PostgreSQL deployment use GET /api/ops/poi-duplicates on the running server.
import { listPoiDuplicateQueue } from '../server/poi/merges.mjs';
import { usesPostgresStorage } from '../server/storage/runtime.mjs';

if (usesPostgresStorage()) {
  console.error('STORAGE_BACKEND=postgres: use GET /api/ops/poi-duplicates on the running server instead.');
  process.exit(2);
}
const city = process.argv[2] || '';
const report = await listPoiDuplicateQueue({ city, limit: 500 });
console.log(JSON.stringify(report, null, 2));
