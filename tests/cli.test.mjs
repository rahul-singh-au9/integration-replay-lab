import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'integration-replay-'));
after(() => rmSync(directory,{recursive:true,force:true}));
const scenario = {
  schemaVersion:1,id:'cli-check',title:'CLI replay check',origin:'imported',
  events:[{recordId:'r1',eventId:'event-1',orderId:'order-1',revision:1,status:'paid',totalCents:2500,occurredAt:'2026-09-17T00:00:00Z'}],
  deliveries:[{id:'d1',recordId:'r1',atMs:0,fault:'timeout-after'}],
};
function run(value, options=[]) {
  const path=join(directory,`${crypto.randomUUID()}.json`);
  writeFileSync(path,JSON.stringify(value));
  return spawnSync(process.execPath,['dist-cli/cli.js',path,...options],{encoding:'utf8'});
}

test('CLI produces actual replay JSON and preserves identity through uncertain-commit retry',() => {
  const result=run(scenario,['--fail-on-conflict','--fail-on-dead-letter']);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  const robust=output.strategies.find(strategy=>strategy.id==='robust');
  assert.equal(robust.metrics.sideEffects,1);
  assert.equal(robust.metrics.duplicates,1);
  assert.equal(robust.attempts.length,2);
});
test('CLI can fail a CI check on a dead letter without hiding the computed result',() => {
  const value=structuredClone(scenario);
  value.deliveries[0].fault='unavailable';
  const result=run(value,['--fail-on-dead-letter']);
  assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).strategies.find(strategy=>strategy.id==='robust').metrics.deadLetters,1);
});
test('CLI can fail a CI check on a reused identity with changed content',() => {
  const value=structuredClone(scenario);
  value.deliveries[0].fault='none';
  value.events.push({...value.events[0],recordId:'r2',totalCents:3500});
  value.deliveries.push({id:'d2',recordId:'r2',atMs:1,fault:'none'});
  const result=run(value,['--fail-on-conflict']);
  assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).strategies.find(strategy=>strategy.id==='robust').metrics.conflicts,1);
});
test('CLI rejects malformed scenarios and unknown options with exit status 2',() => {
  const value=structuredClone(scenario);
  value.events[0].totalCents=-1;
  const invalid=run(value);
  assert.equal(invalid.status,2);
  assert.match(invalid.stderr,/Replay failed/);
  assert.equal(invalid.stdout,'');
  assert.equal(run(scenario,['--invented-option']).status,2);
});
