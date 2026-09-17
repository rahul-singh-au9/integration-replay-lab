import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const wrangler = path.join(project, 'node_modules/wrangler/bin/wrangler.js');
const port = Number(process.env.RECOVERY_PORT ?? 8797);
assert(
  Number.isInteger(port) && port > 1024 && port < 65536,
  'RECOVERY_PORT must be an unprivileged TCP port.',
);
const root = path.join(
  project,
  '.artifacts',
  `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const source = path.join(root, 'source');
const restored = path.join(root, 'restored');
const manifest = {
  startedAt: new Date().toISOString(),
  mode: 'local-only',
  artifacts: root,
  commands: [],
  checks: {},
};
const sessionToken = randomBytes(32).toString('hex');
const owner = createHash('sha256').update(sessionToken).digest('hex');
const rehearsalVersion = `recovery-${randomBytes(8).toString('hex')}`;
const commandEnv = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
let worker;
let workerOutput = '';
let workerLogFilename = 'worker.log';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function run(label, args) {
  const step = manifest.commands.length + 1;
  const command = { label, executable: process.execPath, args: [wrangler, ...args], cwd: project };
  manifest.commands.push(command);
  console.log(`${step}. ${label}`);
  try {
    const { stdout, stderr } = await execute(process.execPath, command.args, {
      cwd: project,
      env: commandEnv,
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(root, `${step}.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    return stdout;
  } catch (error) {
    await writeFile(
      path.join(root, `${step}.log`),
      `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { mode: 0o600 },
    );
    throw error;
  }
}

async function config(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'wrangler.json');
  await writeFile(
    filename,
    JSON.stringify(
      {
        name: 'integration-replay-lab-recovery',
        main: path.join(project, 'worker/index.ts'),
        compatibility_date: '2026-09-17',
        workers_dev: false,
        assets: {
          directory: path.join(project, 'dist'),
          binding: 'ASSETS',
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*', '/__scheduled'],
        },
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'integration-replay-lab',
            database_id: '00000000-0000-0000-0000-000000000000',
            migrations_dir: path.join(project, 'migrations'),
          },
        ],
        ratelimits: [
          { name: 'WRITE_LIMITER', namespace_id: '1002', simple: { limit: 10, period: 60 } },
        ],
        triggers: { crons: ['17 3 * * *'] },
        vars: { APP_VERSION: rehearsalVersion },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return filename;
}

async function query(label, configuration, sql) {
  const output = await run(label, [
    'd1',
    'execute',
    'integration-replay-lab',
    '--local',
    '--config',
    configuration,
    '--command',
    sql,
    '--json',
  ]);
  const result = JSON.parse(output);
  assert(
    result.every((statement) => statement.success),
    `${label} must complete successfully.`,
  );
  return result;
}

async function snapshot(label, configuration) {
  const result = await query(
    label,
    configuration,
    `
    SELECT (SELECT COUNT(*) FROM runs) AS actual_runs,
      (SELECT run_count FROM capacity WHERE id = 1) AS recorded_runs,
      (SELECT COUNT(*) FROM runs WHERE expires_at <= ${Date.now()}) AS expired_runs;
    SELECT type, name FROM sqlite_master WHERE name IN ('runs', 'capacity', 'runs_owner_created', 'runs_expiry', 'runs_insert_count', 'runs_delete_count', 'runs_insert_byte_bounds', 'runs_update_byte_bounds', 'runs_owner_expiry') ORDER BY name;
    SELECT name FROM d1_migrations ORDER BY id;
    SELECT id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result FROM runs ORDER BY id;
  `,
  );
  const counts = result[0].results[0];
  assert.equal(
    counts.actual_runs,
    counts.recorded_runs,
    'Capacity counter must equal the number of rows.',
  );
  assert.deepEqual(result[1].results, [
    { type: 'table', name: 'capacity' },
    { type: 'table', name: 'runs' },
    { type: 'trigger', name: 'runs_delete_count' },
    { type: 'index', name: 'runs_expiry' },
    { type: 'trigger', name: 'runs_insert_byte_bounds' },
    { type: 'trigger', name: 'runs_insert_count' },
    { type: 'index', name: 'runs_owner_created' },
    { type: 'index', name: 'runs_owner_expiry' },
    { type: 'trigger', name: 'runs_update_byte_bounds' },
  ]);
  assert.deepEqual(result[2].results, [
    { name: '0001_runs.sql' },
    { name: '0002_storage_bounds.sql' },
  ]);
  // D1 denies PRAGMA integrity_check. Inspect only this isolated, stopped local
  // SQLite database directly; this is not proof of remote database integrity.
  const persistence = path.join(path.dirname(configuration), '.wrangler/state/v3/d1');
  const files = (await readdir(persistence, { recursive: true })).filter(
    (filename) => filename.endsWith('.sqlite') && path.basename(filename) !== 'metadata.sqlite',
  );
  assert.equal(files.length, 1, 'Expected exactly one isolated local D1 SQLite file.');
  const localDb = new DatabaseSync(path.join(persistence, files[0]), { readOnly: true });
  try {
    assert.equal(localDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    localDb.close();
  }
  return {
    counts,
    schema: result[1].results,
    migrations: result[2].results,
    integrity: 'ok (local SQLite only)',
    contentDigest: createHash('sha256').update(JSON.stringify(result[3].results)).digest('hex'),
  };
}

async function stopWorker() {
  if (!worker) return;
  if (worker.exitCode === null && worker.signalCode === null) {
    const closed = new Promise((resolve) => worker.once('close', resolve));
    worker.kill('SIGTERM');
    await Promise.race([closed, pause(3_000)]);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await Promise.race([closed, pause(3_000)]);
    }
  }
  await writeFile(path.join(root, workerLogFilename), workerOutput, { mode: 0o600 });
  worker = undefined;
}

async function startWorker(configuration, label, logFilename) {
  const args = [
    wrangler,
    'dev',
    '--local',
    '--config',
    configuration,
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
    '--test-scheduled',
  ];
  manifest.commands.push({
    label,
    executable: process.execPath,
    args,
    cwd: project,
  });
  console.log(`${manifest.commands.length}. ${label} on port ${port}`);
  workerOutput = '';
  workerLogFilename = logFilename;
  worker = spawn(process.execPath, args, {
    cwd: project,
    env: commandEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', (chunk) => {
    workerOutput += chunk;
  });
  worker.stderr.on('data', (chunk) => {
    workerOutput += chunk;
  });
  let startupError;
  worker.once('error', (error) => {
    startupError = error;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    assert.equal(worker.exitCode, null, 'The isolated Worker exited before becoming healthy.');
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        manifest.checks.health = await response.json();
        if (manifest.checks.health.version === rehearsalVersion) {
          healthy = true;
          break;
        }
      }
    } catch {
      /* The local process may still be starting. */
    }
    await pause(200);
  }
  assert(healthy, 'The isolated local Worker must become healthy.');
  assert.equal(manifest.checks.health.ok, true);
  return manifest.checks.health;
}

try {
  // Export has no --persist-to flag in the pinned Wrangler version. Each isolated
  // config therefore gets its own default .wrangler/state directory.
  await mkdir(root, { recursive: true, mode: 0o700 });
  await readFile(path.join(project, 'dist/index.html'));
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  const sourceConfig = await config(source);
  const restoreConfig = await config(restored);
  await run('Apply migrations to an empty isolated source', [
    'd1',
    'migrations',
    'apply',
    'integration-replay-lab',
    '--local',
    '--config',
    sourceConfig,
  ]);
  const now = Date.now();
  const scenario = {
    schemaVersion: 1,
    id: 'recovery-example',
    title: 'Synthetic recovery example',
    origin: 'fixture',
    events: [
      {
        recordId: 'record-1',
        eventId: 'event-1',
        orderId: 'order-1',
        revision: 1,
        status: 'paid',
        totalCents: 1250,
        occurredAt: '2026-09-17T09:00:00Z',
      },
    ],
    deliveries: [{ id: 'delivery-1', recordId: 'record-1', atMs: 0, fault: 'timeout-after' }],
  };
  const scenarioFile = path.join(root, 'synthetic-scenario.json');
  await writeFile(scenarioFile, JSON.stringify(scenario), { mode: 0o600 });
  const cli = path.join(project, 'dist-cli/cli.js');
  await readFile(cli);
  const replayCommand = {
    label: 'Generate the synthetic saved result using the built replay engine',
    executable: process.execPath,
    args: [cli, scenarioFile],
    cwd: project,
  };
  manifest.commands.push(replayCommand);
  console.log(`${manifest.commands.length}. ${replayCommand.label}`);
  const replayOutput = await execute(process.execPath, replayCommand.args, {
    cwd: project,
    env: commandEnv,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const replay = JSON.parse(replayOutput.stdout);
  assert.equal(replay.engineVersion, '1.0.0');
  assert.equal(replay.scenarioId, scenario.id);
  assert.equal(
    replay.strategies.find((strategy) => strategy.id === 'robust').metrics.sideEffects,
    1,
  );
  const insert = (id, expiresAt) =>
    `INSERT INTO runs (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result) VALUES (${sqlLiteral(id)}, ${sqlLiteral(owner)}, ${sqlLiteral(scenario.title)}, ${sqlLiteral(scenario.origin)}, ${now - 31 * 86_400_000}, ${expiresAt}, 1, ${sqlLiteral(JSON.stringify(scenario))}, ${sqlLiteral(JSON.stringify(replay))});`;
  const expiredId = '11111111-1111-4111-8111-111111111111';
  const retainedId = '22222222-2222-4222-8222-222222222222';
  const transientId = '33333333-3333-4333-8333-333333333333';
  await query(
    'Seed one expired and one unexpired synthetic run',
    sourceConfig,
    insert(expiredId, now - 86_400_000) + insert(retainedId, now + 86_400_000),
  );
  manifest.checks.sourceHealth = await startWorker(
    sourceConfig,
    'Create a digest-backed run through the actual isolated source Worker',
    'source-worker.log',
  );
  const sourceBase = `http://127.0.0.1:${port}`;
  const digestResponse = await fetch(`${sourceBase}/api/runs`, {
    method: 'POST',
    headers: {
      Cookie: `irl_session=${sessionToken}`,
      Origin: sourceBase,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ scenario }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(digestResponse.status, 201, 'The actual Worker must create the digest-backed run.');
  const digestRun = (await digestResponse.json()).run;
  assert.match(
    digestRun.id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.deepEqual(digestRun.scenario, scenario);
  assert.deepEqual(digestRun.result, replay);
  const digestId = digestRun.id;
  await stopWorker();
  const digestStored = await query(
    'Verify the Worker stored a versioned canonical-result digest for the correct owner',
    sourceConfig,
    `SELECT owner_id, scenario, result FROM runs WHERE id = ${sqlLiteral(digestId)};`,
  );
  assert.equal(digestStored[0].results.length, 1);
  const digestRow = digestStored[0].results[0];
  assert.equal(digestRow.owner_id, owner);
  assert.deepEqual(JSON.parse(digestRow.scenario), scenario);
  const digestEnvelope = JSON.parse(digestRow.result);
  assert.deepEqual(digestEnvelope, {
    format: 'integration-replay-result-digest',
    schemaVersion: 1,
    engineVersion: replay.engineVersion,
    sha256: createHash('sha256').update(JSON.stringify(replay)).digest('hex'),
  });
  manifest.checks.digestCreation = {
    status: digestResponse.status,
    id: digestId,
    format: digestEnvelope.format,
    storedResultBytes: Buffer.byteLength(digestRow.result),
    verifiedCanonicalDigest: true,
    verifiedOwner: true,
  };
  manifest.checks.source = await snapshot(
    'Verify source schema, counter, migration history and integrity',
    sourceConfig,
  );
  assert.deepEqual(manifest.checks.source.counts, {
    actual_runs: 3,
    recorded_runs: 3,
    expired_runs: 1,
  });
  const backup = path.join(root, 'backup.sql');
  await run('Export only the isolated local source database', [
    'd1',
    'export',
    'integration-replay-lab',
    '--local',
    '--config',
    sourceConfig,
    '--output',
    backup,
  ]);
  const backupSql = await readFile(backup, 'utf8');
  for (const name of [
    'runs_insert_count',
    'runs_delete_count',
    'runs_insert_byte_bounds',
    'runs_update_byte_bounds',
  ]) {
    assert(backupSql.includes(`CREATE TRIGGER ${name}`), `Backup must contain ${name}.`);
  }
  await run('Restore SQL into a separate empty local database', [
    'd1',
    'execute',
    'integration-replay-lab',
    '--local',
    '--config',
    restoreConfig,
    '--file',
    backup,
    '--yes',
  ]);
  manifest.checks.restored = await snapshot(
    'Verify restored schema, counter, history and integrity',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.restored, manifest.checks.source);
  await query(
    'Exercise the restored insertion trigger',
    restoreConfig,
    insert(transientId, now + 86_400_000),
  );
  const inserted = await query(
    'Check the restored insertion counter',
    restoreConfig,
    'SELECT run_count FROM capacity WHERE id = 1;',
  );
  assert.equal(inserted[0].results[0].run_count, 4);
  await query(
    'Exercise the restored deletion trigger',
    restoreConfig,
    `DELETE FROM runs WHERE id = ${sqlLiteral(transientId)};`,
  );
  manifest.checks.triggers = await snapshot(
    'Confirm restored trigger behavior and retained rows',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.triggers.counts, {
    actual_runs: 3,
    recorded_runs: 3,
    expired_runs: 1,
  });
  for (const [label, sql] of [
    [
      'Restored update trigger rejects an oversized multibyte scenario',
      `UPDATE runs SET scenario = replace(hex(zeroblob(30000)), '00', '界') WHERE id = ${sqlLiteral(retainedId)};`,
    ],
    [
      'Restored insert trigger rejects an oversized multibyte result',
      `INSERT INTO runs (id, owner_id, title, origin, created_at, expires_at, event_count, scenario, result) SELECT ${sqlLiteral(transientId)}, owner_id, title, origin, created_at, expires_at, event_count, scenario, replace(hex(zeroblob(200000)), '00', '界') FROM runs WHERE id = ${sqlLiteral(retainedId)};`,
    ],
  ]) {
    let rejected = false;
    try {
      await query(label, restoreConfig, sql);
    } catch (error) {
      assert.match(
        `${error.stdout ?? ''} ${error.stderr ?? ''}`,
        /Run storage byte limit exceeded/,
      );
      rejected = true;
    }
    assert(rejected, `${label} must reject the write.`);
  }
  manifest.checks.byteBounds = await snapshot(
    'Verify rejected writes preserved restored rows and counter',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.byteBounds, manifest.checks.triggers);
  manifest.checks.restoredHealth = await startWorker(
    restoreConfig,
    'Serve the restored local database and invoke the actual scheduled handler',
    'restored-worker.log',
  );
  const base = `http://127.0.0.1:${port}`;
  const workspaceHeaders = { Cookie: `irl_session=${sessionToken}` };
  const restoredReads = [];
  for (const [format, id] of [
    ['legacy-full-result', retainedId],
    ['result-digest', digestId],
  ]) {
    const retainedResponse = await fetch(`${base}/api/runs/${id}`, {
      headers: workspaceHeaders,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(retainedResponse.status, 200, `${format} must remain readable after restore.`);
    const retainedRun = (await retainedResponse.json()).run;
    assert.deepEqual(retainedRun.scenario, scenario);
    assert.deepEqual(retainedRun.result, replay);
    const foreignResponse = await fetch(`${base}/api/runs/${id}`, {
      headers: { Cookie: `irl_session=${randomBytes(32).toString('hex')}` },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(foreignResponse.status, 404);
    restoredReads.push({
      format,
      id,
      ownerRead: retainedResponse.status,
      foreignRead: foreignResponse.status,
    });
  }
  const expiredResponse = await fetch(`${base}/api/runs/${expiredId}`, {
    headers: workspaceHeaders,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(expiredResponse.status, 404);
  manifest.checks.restoredApi = {
    verifiedScenarioAndResultForBothFormats: true,
    formats: restoredReads,
    expiredRead: expiredResponse.status,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/__scheduled?cron=${encodeURIComponent('17 3 * * *')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(body, 'Ran scheduled event');
    manifest.checks[`scheduled${attempt + 1}`] = { status: response.status, body };
  }
  await stopWorker();
  manifest.checks.afterCleanup = await snapshot(
    'Verify actual scheduled cleanup and idempotence',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.afterCleanup.counts, {
    actual_runs: 2,
    recorded_runs: 2,
    expired_runs: 0,
  });
  const survivor = await query(
    'Verify cleanup preserved both unexpired storage formats',
    restoreConfig,
    'SELECT id, result FROM runs ORDER BY id;',
  );
  assert.deepEqual(
    survivor[0].results,
    [
      { id: retainedId, result: JSON.stringify(replay) },
      { id: digestId, result: digestRow.result },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  manifest.checks.preservedStorageFormats = {
    legacyFullResultUnchanged: true,
    digestEnvelopeUnchanged: true,
    ownedUnexpiredRuns: 2,
  };
  manifest.checks.sourceUnchanged = await snapshot(
    'Verify the isolated export source was unchanged',
    sourceConfig,
  );
  assert.deepEqual(manifest.checks.sourceUnchanged, manifest.checks.source);
  manifest.status = 'passed';
  console.log(`Recovery rehearsal passed. Evidence: ${path.join(root, 'manifest.json')}`);
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error instanceof Error ? error.message : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopWorker();
  manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
}
