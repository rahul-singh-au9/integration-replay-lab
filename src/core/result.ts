import { createReplay, type ReplayResult } from './replay';
import type { Scenario } from './schema';

/** Traverses only the bounded shape of a freshly computed replay. */
function matchesReplay(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    expected === null ||
    typeof expected !== 'object' ||
    actual === null ||
    typeof actual !== 'object'
  )
    return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => matchesReplay(actual[index], value));
  }
  if (Array.isArray(actual)) return false;
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = Object.keys(expectedRecord);
  if (Object.keys(actualRecord).length !== keys.length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(actualRecord, key) && matchesReplay(actualRecord[key], expectedRecord[key]),
  );
}

/** A saved artifact must agree with the supported engine before it is displayed. */
export function parseSavedReplay(
  scenarioInput: unknown,
  resultInput: unknown,
): { scenario: Scenario; result: ReplayResult } {
  if (resultInput === null || typeof resultInput !== 'object' || Array.isArray(resultInput)) {
    throw new Error(
      'Saved replay result must be an object. Run the scenario again to produce a new result.',
    );
  }
  const engineVersion = (resultInput as Record<string, unknown>).engineVersion;
  if (engineVersion !== '1.0.0') {
    throw new Error(
      'This saved replay uses an unsupported engine version. Import its scenario and run it again to produce a new result.',
    );
  }
  const replay = createReplay(scenarioInput);
  if (!matchesReplay(resultInput, replay.result)) {
    throw new Error(
      'Saved replay does not match its scenario and engine version. Run the scenario again to produce a new result.',
    );
  }
  return replay;
}
