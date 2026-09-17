import type { Scenario } from '../core/schema';
import type { ReplayResult } from '../core/replay';

export interface SessionInfo { retentionDays: number; maxRuns: number }
export interface RunSummary { id: string; title: string; origin: 'fixture' | 'imported'; createdAt: string; eventCount: number }
export interface SavedRun extends RunSummary { scenario: Scenario; result: ReplayResult }

export class ApiError extends Error {
  constructor(message: string, public status = 0, public requestId?: string, public retryAfter?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: controller.signal,
    });
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      throw new ApiError('Server replay is unavailable. Run locally to inspect this scenario without saving.', response.status);
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      const details = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
      throw new ApiError(typeof details.error === 'string' ? details.error : 'The request could not be completed.', response.status,
        typeof details.requestId === 'string' ? details.requestId : undefined, response.headers.get('retry-after') ?? undefined);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError('The server response timed out. Refresh saved replays before running again; the server may have finished.');
    throw new ApiError('Could not connect to the replay server. Run locally or retry the connection.');
  } finally { window.clearTimeout(timeout); }
}

let sessionRequest: Promise<SessionInfo> | null = null;
export async function ensureSession(): Promise<SessionInfo> {
  if (sessionRequest) return sessionRequest;
  sessionRequest = (async () => {
    try { return await request<SessionInfo>('/api/session'); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      return request<SessionInfo>('/api/session', { method: 'POST', body: '{}' });
    }
  })();
  try { return await sessionRequest; }
  finally { sessionRequest = null; }
}

export async function listRuns(): Promise<RunSummary[]> {
  const body = await request<{ runs: RunSummary[] }>('/api/runs');
  return body.runs;
}
export async function createRun(scenario: Scenario): Promise<SavedRun> {
  const body = await request<{ run: SavedRun }>('/api/runs', { method: 'POST', body: JSON.stringify({ scenario }) });
  return body.run;
}
export async function loadRun(id: string): Promise<SavedRun> {
  const body = await request<{ run: SavedRun }>(`/api/runs/${encodeURIComponent(id)}`);
  return body.run;
}
export async function deleteRun(id: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
