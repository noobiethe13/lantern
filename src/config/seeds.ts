import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

interface SeedSourceEntry {
  type: string;
  identifier: string;
}

function seedKey(type: string, identifier: string): string {
  return `${type.toLowerCase()}::${identifier.toLowerCase()}`;
}

/**
 * Whether (type, identifier) is one of the maintained default seed-list
 * entries in src/config/seed-sources.yml. `runner/scan.ts`'s seedSources()
 * re-inserts every entry here (INSERT OR IGNORE) on each scan, so a route
 * that lets the user hard-delete one of these would just have it reappear —
 * callers should soft-disable instead. Comparison is case-insensitive.
 */
export function isSeededSource(type: string, identifier: string): boolean {
  const seedPath = join(process.cwd(), 'src/config/seed-sources.yml');
  const raw = yaml.load(readFileSync(seedPath, 'utf-8')) as { sources?: SeedSourceEntry[] };
  return (raw.sources ?? []).some(s => seedKey(s.type, s.identifier) === seedKey(type, identifier));
}
