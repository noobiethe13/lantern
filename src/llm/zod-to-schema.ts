import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Produces a JSON Schema acceptable to Claude Code's `--json-schema` flag.
// zod-to-json-schema emits a `$schema` URL pointing at the JSON Schema draft,
// which some consumers reject as an unknown keyword;
// strip it. `definitions`/`$ref` are also avoided by inlining via `$refStrategy: 'none'`.
export function zodToProviderSchema(schema: ZodType): Record<string, unknown> {
  const out = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}
