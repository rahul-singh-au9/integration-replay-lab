import { z } from 'zod';
import { type Scenario } from '../core/schema';
import type { ReplayResult } from '../core/replay';
import { parseSavedReplay } from '../core/result';

export interface SessionInfo {
  retentionDays: number;
  maxRuns: number;
}
export interface RunSummary {
  id: string;
  title: string;
  origin: 'fixture' | 'imported';
  createdAt: string;
  eventCount: number;
}
export interface SavedRun extends RunSummary {
  scenario: Scenario;
  result: ReplayResult;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public requestId?: string,
    public retryAfter?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const sessionSchema = z.object({
  retentionDays: z.number().int().positive(),
  maxRuns: z.number().int().positive(),
});
const summarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(160),
  origin: z.enum(['fixture', 'imported']),
  createdAt: z.string().datetime({ offset: true }),
  eventCount: z.number().int().min(1).max(50),
});

function decode<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      'Replay storage returned an invalid response. Refresh saved replays before running again; your local scenario is unchanged.',
    );
  return parsed.data;
}

function decodeRun(body: unknown): SavedRun {
  const { run } = decode(
    z.object({ run: summarySchema.extend({ scenario: z.unknown(), result: z.unknown() }) }),
    body,
  );
  try {
    const { scenario, result } = parseSavedReplay(run.scenario, run.result);
    if (
      run.title !== scenario.title ||
      run.origin !== scenario.origin ||
      run.eventCount !== scenario.events.length
    )
      throw new Error('Replay metadata does not match its scenario.');
    return { ...run, scenario, result };
  } catch {
    throw new ApiError(
      'The saved replay is invalid. Refresh saved replays before running again; your current local scenario is unchanged.',
    );
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });
    if (!(response.headers.get('content-type') ?? '').includes('application/json'))
      throw new ApiError(
        'Server replay is unavailable. Run locally to inspect this scenario without saving.',
        response.status,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ApiError(
        'Replay storage returned invalid JSON. Refresh saved replays before running again; your local scenario is unchanged.',
        response.status,
      );
    }
    if (!response.ok) {
      const details =
        body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      throw new ApiError(
        typeof details.error === 'string' ? details.error : 'The request could not be completed.',
        response.status,
        typeof details.requestId === 'string' ? details.requestId : undefined,
        response.headers.get('retry-after') ?? undefined,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted)
      throw new ApiError(
        'The server response timed out. Refresh saved replays before running again; the server may have finished.',
      );
    throw new ApiError(
      'Could not connect to the replay server. Run locally or retry the connection.',
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

let sessionRequest: Promise<SessionInfo> | null = null;
async function coordinateSession(initialize: () => Promise<SessionInfo>): Promise<SessionInfo> {
  if (typeof navigator === 'undefined' || !navigator.locks) return initialize();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    return await navigator.locks.request(
      'integration-replay-lab-session',
      { signal: controller.signal },
      () => {
        window.clearTimeout(timeout);
        return initialize();
      },
    );
  } catch (error) {
    if (controller.signal.aborted)
      throw new ApiError(
        'Another tab is still connecting to storage. Retry the connection in a moment; your local scenario is unchanged.',
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function ensureSession(): Promise<SessionInfo> {
  if (sessionRequest) return sessionRequest;
  sessionRequest = coordinateSession(async () => {
    try {
      return decode(sessionSchema, await request('/api/session'));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      return decode(sessionSchema, await request('/api/session', { method: 'POST', body: '{}' }));
    }
  });
  try {
    return await sessionRequest;
  } finally {
    sessionRequest = null;
  }
}

export async function listRuns(): Promise<RunSummary[]> {
  return decode(z.object({ runs: z.array(summarySchema).max(20) }), await request('/api/runs'))
    .runs;
}
export async function createRun(scenario: Scenario): Promise<SavedRun> {
  return decodeRun(
    await request('/api/runs', { method: 'POST', body: JSON.stringify({ scenario }) }),
  );
}
export async function loadRun(id: string): Promise<SavedRun> {
  return decodeRun(await request(`/api/runs/${encodeURIComponent(id)}`));
}
export async function deleteRun(id: string): Promise<void> {
  decode(
    z.object({ ok: z.literal(true) }),
    await request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}
