import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_BUNDLE_BYTES, parseImport } from './core/bundle';
import { createReplay } from './core/replay';

async function readScenarioFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('Scenario input must be a regular file.');
    if (metadata.size > MAX_BUNDLE_BYTES) throw new Error('Scenario bundle exceeds 1 MiB.');
    // Bound reads as well as the initial size check: a file may grow after stat.
    const bytes = new Uint8Array(MAX_BUNDLE_BYTES + 1);
    let length = 0;
    while (length <= MAX_BUNDLE_BYTES) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BUNDLE_BYTES) throw new Error('Scenario bundle exceeds 1 MiB.');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      );
    } catch {
      throw new Error('Scenario file must contain valid UTF-8.');
    }
  } finally {
    await file.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const accepted = new Set(['--fail-on-conflict', '--fail-on-dead-letter']);
  if (!args[0] || (args[0] === '--help' && args.length === 1)) {
    process.stdout.write(
      'Usage: npm run replay -- scenario.json [--fail-on-conflict] [--fail-on-dead-letter]\n',
    );
    process.exitCode = args[0] === '--help' ? 0 : 2;
    return;
  }
  if (args[0].startsWith('--') || args.slice(1).some((arg) => !accepted.has(arg)))
    throw new Error('Unknown option. Use --help for supported arguments.');
  const raw = await readScenarioFile(args[0]);
  const { result } = createReplay(parseImport(raw));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const guarded = result.strategies.find((strategy) => strategy.id === 'robust')!;
  if (
    (args.includes('--fail-on-conflict') && guarded.metrics.conflicts > 0) ||
    (args.includes('--fail-on-dead-letter') && guarded.metrics.deadLetters > 0)
  )
    process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `Replay failed: ${error instanceof Error ? error.message : 'Invalid scenario'}\n`,
  );
  process.exitCode = 2;
});
