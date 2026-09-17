import { z } from 'zod';
import { parseScenario, parseScenarioText, type Scenario } from './schema';

export const MAX_BUNDLE_BYTES = 1024 * 1024;
const bundleSchema = z.strictObject({
  format: z.literal('integration-replay-lab'),
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  scenario: z.unknown(),
  engineVersion: z.string().min(1).max(40).optional(),
  result: z.unknown().optional(),
});

export function parseImport(text: string): Scenario {
  if (new TextEncoder().encode(text).byteLength > MAX_BUNDLE_BYTES)
    throw new Error('This input exceeds 1 MiB. Raw scenarios must be within 64 KiB.');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('This is not valid JSON. Check the formatting and try again.');
  }
  if (input !== null && typeof input === 'object' && ('scenario' in input || 'format' in input)) {
    const bundle = bundleSchema.safeParse(input);
    if (!bundle.success)
      throw new Error(
        'This is not a supported replay export. Use a version 1 Integration Replay Lab bundle or a raw scenario.',
      );
    return parseScenario(bundle.data.scenario);
  }
  return parseScenarioText(text);
}

export function decodeImportBytes(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_BUNDLE_BYTES)
    throw new Error(
      'File exceeds 1 MiB. Use a raw scenario up to 64 KiB or an exported bundle up to 1 MiB.',
    );
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('This file is not valid UTF-8. Save the JSON as UTF-8 and select it again.');
  }
}
