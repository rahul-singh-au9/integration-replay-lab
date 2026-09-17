import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'integration-replay-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const scenario = {
  schemaVersion: 1,
  id: 'cli-check',
  title: 'CLI replay check',
  origin: 'imported',
  events: [
    {
      recordId: 'r1',
      eventId: 'event-1',
      orderId: 'order-1',
      revision: 1,
      status: 'paid',
      totalCents: 2500,
      occurredAt: '2026-09-17T00:00:00Z',
    },
  ],
  deliveries: [{ id: 'd1', recordId: 'r1', atMs: 0, fault: 'timeout-after' }],
};
function runRaw(contents, options = []) {
  const path = join(directory, `${crypto.randomUUID()}.json`);
  writeFileSync(path, contents);
  return spawnSync(process.execPath, ['dist-cli/cli.js', path, ...options], {
    encoding: 'utf8',
    timeout: 5000,
  });
}
function run(value, options = []) {
  return runRaw(JSON.stringify(value), options);
}

test('CLI produces actual replay JSON and preserves identity through uncertain-commit retry', () => {
  const result = run(scenario, ['--fail-on-conflict', '--fail-on-dead-letter']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const robust = output.strategies.find((strategy) => strategy.id === 'robust');
  assert.equal(robust.metrics.sideEffects, 1);
  assert.equal(robust.metrics.duplicates, 1);
  assert.equal(robust.attempts.length, 2);
});
test('CLI can fail a CI check on a dead letter without hiding the computed result', () => {
  const value = structuredClone(scenario);
  value.deliveries[0].fault = 'unavailable';
  const result = run(value, ['--fail-on-dead-letter']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).strategies.find((strategy) => strategy.id === 'robust').metrics
      .deadLetters,
    1,
  );
});
test('CLI can fail a CI check on a reused identity with changed content', () => {
  const value = structuredClone(scenario);
  value.deliveries[0].fault = 'none';
  value.events.push({ ...value.events[0], recordId: 'r2', totalCents: 3500 });
  value.deliveries.push({ id: 'd2', recordId: 'r2', atMs: 1, fault: 'none' });
  const result = run(value, ['--fail-on-conflict']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).strategies.find((strategy) => strategy.id === 'robust').metrics
      .conflicts,
    1,
  );
});
test('CLI rejects malformed scenarios and unknown options with exit status 2', () => {
  const value = structuredClone(scenario);
  value.events[0].totalCents = -1;
  const invalid = run(value);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Replay failed/);
  assert.equal(invalid.stdout, '');
  assert.equal(run(scenario, ['--invented-option']).status, 2);
});
test('CLI supports help and rejects missing input or ambiguous invocation', () => {
  const invoke = (args) =>
    spawnSync(process.execPath, ['dist-cli/cli.js', ...args], { encoding: 'utf8', timeout: 5000 });
  const help = invoke(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.equal(invoke([]).status, 2);
  assert.equal(invoke(['--help', 'unexpected.json']).status, 2);
  assert.equal(invoke(['--fail-on-conflict']).status, 2);
});
test('CLI recomputes exported scenarios and never trusts an included result', () => {
  const result = run({
    format: 'integration-replay-lab',
    schemaVersion: 1,
    exportedAt: '2026-09-17T00:00:00Z',
    scenario,
    engineVersion: '0.0.0',
    result: { strategies: [] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).engineVersion, '1.0.0');
  assert.equal(JSON.parse(result.stdout).strategies.length, 2);
  for (const bundle of [
    { scenario },
    { format: 'some-other-app', schemaVersion: 1, exportedAt: '2026-09-17T00:00:00Z', scenario },
  ]) {
    const rejected = run(bundle);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /supported replay export/);
    assert.equal(rejected.stdout, '');
  }
});
test('CLI enforces raw and bundle byte limits before replaying', () => {
  const text = JSON.stringify(scenario);
  assert.equal(runRaw(text.padEnd(64 * 1024)).status, 0);
  const oversizedRaw = runRaw(text.padEnd(64 * 1024 + 1));
  assert.equal(oversizedRaw.status, 2);
  assert.match(oversizedRaw.stderr, /64 KiB/);
  const oversizedBundle = runRaw(' '.repeat(1024 * 1024 + 1));
  assert.equal(oversizedBundle.status, 2);
  assert.match(oversizedBundle.stderr, /1 MiB/);
  assert.equal(oversizedBundle.stdout, '');
});
test('CLI rejects malformed UTF-8 and JSON without printing a replay', () => {
  const text = JSON.stringify(scenario);
  const marker = 'CLI replay check';
  const offset = text.indexOf(marker);
  const invalidUtf8 = Buffer.concat([
    Buffer.from(text.slice(0, offset)),
    Buffer.from([0xff]),
    Buffer.from(text.slice(offset + marker.length)),
  ]);
  const invalid = runRaw(invalidUtf8);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /valid UTF-8/);
  assert.equal(invalid.stdout, '');
  const malformed = runRaw('{');
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /valid JSON/);
  assert.equal(malformed.stdout, '');
});
test(
  'CLI rejects directories and never waits for bytes from a named pipe',
  { skip: process.platform === 'win32' },
  () => {
    const invoke = (path) =>
      spawnSync(process.execPath, ['dist-cli/cli.js', path], { encoding: 'utf8', timeout: 5000 });
    const folder = invoke(directory);
    assert.equal(folder.status, 2);
    assert.match(folder.stderr, /regular file/);
    const fifo = join(directory, 'scenario-pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 });
    assert.equal(created.status, 0, created.stderr);
    const pipe = invoke(fifo);
    assert.equal(pipe.status, 2, pipe.stderr);
    assert.match(pipe.stderr, /regular file/);
  },
);
