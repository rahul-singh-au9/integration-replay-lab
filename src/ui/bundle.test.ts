import { describe, expect, it } from 'vitest';
import { fixtures } from '../core/fixtures';
import { MAX_BUNDLE_BYTES, decodeImportBytes, parseImport } from './bundle';

const scenario = fixtures[0].scenario;
const bundle = {
  format: 'integration-replay-lab',
  schemaVersion: 1,
  exportedAt: '2026-09-17T00:00:00Z',
  scenario,
};

describe('scenario and bundle import', () => {
  it('accepts raw scenarios and ignores exported results that must be recomputed', () => {
    expect(parseImport(JSON.stringify(scenario))).toEqual(scenario);
    expect(
      parseImport(
        JSON.stringify({
          ...bundle,
          engineVersion: 'future-version',
          result: { fake: 'untrusted result' },
        }),
      ),
    ).toEqual(scenario);
  });
  it.each([
    { scenario },
    { ...bundle, format: 'unrelated-application' },
    { ...bundle, schemaVersion: 2 },
    { ...bundle, exportedAt: 'not a timestamp' },
    { ...bundle, extraField: true },
    { ...bundle, engineVersion: 1 },
  ])('rejects unsupported bundle metadata', (input) => {
    expect(() => parseImport(JSON.stringify(input))).toThrow('not a supported replay export');
  });
  it.each(['{', 'null', '[]', '"hello"'])('rejects invalid or non-scenario JSON', (input) => {
    expect(() => parseImport(input)).toThrow();
  });
  it('checks UTF-8 bytes and the separate raw scenario and bundle limits', () => {
    expect(() => parseImport(' '.repeat(MAX_BUNDLE_BYTES + 1))).toThrow('exceeds 1 MiB');
    expect(() => parseImport(' '.repeat(64 * 1024) + JSON.stringify(scenario))).toThrow('64 KiB');
    expect(() =>
      parseImport(JSON.stringify({ ...bundle, result: 'あ'.repeat(MAX_BUNDLE_BYTES / 2) })),
    ).toThrow('exceeds 1 MiB');
  });
  it('rejects invalid referenced records in a supported bundle', () => {
    expect(() =>
      parseImport(JSON.stringify({ ...bundle, scenario: { ...scenario, events: [] } })),
    ).toThrow();
  });
});

describe('file decoding', () => {
  it('decodes UTF-8 and permits a standard UTF-8 byte-order mark', () => {
    const bytes = new TextEncoder().encode('\uFEFF' + JSON.stringify(scenario));
    expect(parseImport(decodeImportBytes(bytes.buffer))).toEqual(scenario);
  });
  it('rejects malformed UTF-8 instead of silently replacing the scenario contents', () => {
    expect(() => decodeImportBytes(new Uint8Array([0xc3, 0x28]).buffer)).toThrow('not valid UTF-8');
  });
  it('checks byte size before decoding', () => {
    expect(() => decodeImportBytes(new ArrayBuffer(MAX_BUNDLE_BYTES + 1))).toThrow('exceeds 1 MiB');
  });
});
