import { readFile } from 'node:fs/promises';
import { parseScenario, parseScenarioText } from './core/schema';
import { replayScenario } from './core/replay';

async function main() {
  const args = process.argv.slice(2);
  const accepted = new Set(['--fail-on-conflict', '--fail-on-dead-letter']);
  if (!args[0] || args[0] === '--help') {
    process.stdout.write('Usage: npm run replay -- scenario.json [--fail-on-conflict] [--fail-on-dead-letter]\n');
    process.exitCode = args[0] === '--help' ? 0 : 2;
    return;
  }
  if (args.slice(1).some(arg => !accepted.has(arg))) throw new Error('Unknown option. Use --help for supported arguments.');
  const raw = await readFile(args[0], 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error('Scenario bundle exceeds 1 MiB.');
  const input: unknown = JSON.parse(raw);
  const scenario = input && typeof input === 'object' && 'scenario' in input ? parseScenario(input.scenario) : parseScenarioText(raw);
  const result = replayScenario(scenario);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const guarded = result.strategies.find(strategy => strategy.id === 'robust')!;
  if ((args.includes('--fail-on-conflict') && guarded.metrics.conflicts > 0)
    || (args.includes('--fail-on-dead-letter') && guarded.metrics.deadLetters > 0)) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`Replay failed: ${error instanceof Error ? error.message : 'Invalid scenario'}\n`);
  process.exitCode = 2;
});
