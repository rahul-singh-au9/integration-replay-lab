import { useEffect, useRef, useState } from 'react';
import { fixtures } from '../core/fixtures';
import { MAX_SAVED_EVENTS, MAX_SAVED_DELIVERIES, type Scenario } from '../core/schema';
import { replayScenario, type ReplayResult } from '../core/replay';
import * as api from './api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { decodeImportBytes, MAX_BUNDLE_BYTES, parseImport } from './bundle';

type Strategy = ReplayResult['strategies'][number];
type Attempt = Strategy['attempts'][number];
type Tab = 'results' | 'scenario' | 'method';
type Notice = { kind: 'success' | 'error' | 'info'; text: string };
type ActiveReplay = {
  result: ReplayResult;
  mode: 'server' | 'local';
  savedId?: string;
  createdAt?: string;
};
const transportLabels = {
  acknowledged: 'Acknowledged',
  'timeout-before': 'Timeout before',
  'timeout-after': 'Timeout after',
  unavailable: 'Unavailable',
};
const decisionLabels = {
  applied: 'Applied',
  duplicate: 'Duplicate ignored',
  stale: 'Stale ignored',
  conflict: 'Conflict rejected',
  'not-received': 'Not received',
};
const virtualTime = (ms: number) =>
  ms < 1000 ? `+${ms} ms` : `+${Number((ms / 1000).toFixed(3))} s`;
const number = (value: number) => new Intl.NumberFormat('en').format(value);
const date = (value?: string) =>
  value && !Number.isNaN(new Date(value).valueOf())
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Date unavailable';

function errorMessage(error: unknown) {
  if (error instanceof api.ApiError) {
    const retry =
      error.status === 429
        ? ` Too many requests. ${error.retryAfter && /^\d+$/.test(error.retryAfter) ? `Retry after ${error.retryAfter} seconds.` : 'Wait a moment, then retry.'}`
        : '';
    return `${error.message}${retry}${error.requestId ? ` Request ID: ${error.requestId}.` : ''}`;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

function downloadBundle(scenario: Scenario, result?: ReplayResult) {
  const bundle = {
    format: 'integration-replay-lab',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    scenario,
    ...(result ? { engineVersion: result.engineVersion, result } : {}),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${
    scenario.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 65) || 'scenario'
  }-replay.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TransportBadge({ attempt }: { attempt: Attempt }) {
  return (
    <span
      className={`badge ${attempt.transport === 'acknowledged' ? 'badge-success' : attempt.transport === 'unavailable' ? 'badge-danger' : 'badge-warning'}`}
    >
      {transportLabels[attempt.transport]}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: Attempt['decision'] }) {
  return (
    <span
      className={`badge ${decision === 'applied' ? 'badge-info' : decision === 'conflict' ? 'badge-danger' : ''}`}
    >
      {decisionLabels[decision]}
    </span>
  );
}

function InputPreview({ scenario }: { scenario: Scenario }) {
  return (
    <section className="empty-result" aria-label="Scenario ready to replay">
      <div className="empty-intro">
        <div className="flow-mark">
          <span>
            <Icon name="layers" size={21} />
          </span>
          <i />
          <span>
            <Icon name="refresh" size={22} />
          </span>
          <i />
          <span>
            <Icon name="compare" size={22} />
          </span>
        </div>
        <h2>One delivery plan. Two consumers.</h2>
        <p>
          Replay the same order snapshots against a naive consumer and one that checks event
          identity and revision. Inspect the difference in state, side effects, and retries.
        </p>
        <p className="small">
          This is scenario input, not a completed run. No webhook is sent and the retry clock is
          virtual.
        </p>
      </div>
      <div className="input-preview">
        <div className="section-heading">
          <h3>Planned deliveries</h3>
          <span className="count-pill">{scenario.deliveries.length}</span>
        </div>
        <div className="input-events">
          {scenario.deliveries.slice(0, 5).map((delivery, index) => {
            const event = scenario.events.find((item) => item.recordId === delivery.recordId);
            return (
              <div className="input-event" key={delivery.id}>
                <span className="event-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>
                    {event?.orderId} <span className="muted">/ revision {event?.revision}</span>
                  </strong>
                  <p>
                    {virtualTime(delivery.atMs)} · {event?.status} ·{' '}
                    {delivery.fault === 'none'
                      ? 'No injected fault'
                      : delivery.fault.replace(/-/g, ' ')}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        {scenario.deliveries.length > 5 && (
          <p className="small muted">+{scenario.deliveries.length - 5} more in Scenario JSON.</p>
        )}
      </div>
    </section>
  );
}

function StrategyCard({ strategy }: { strategy: Strategy }) {
  return (
    <section className={`strategy-card ${strategy.id === 'robust' ? 'robust' : ''}`}>
      <div className="strategy-heading">
        <span className="eyebrow">
          {strategy.id === 'robust' ? 'Idempotency + revision guard' : 'Baseline consumer'}
        </span>
        <div className="strategy-title">
          <h3>{strategy.name}</h3>
          <Icon name={strategy.id === 'robust' ? 'layers' : 'terminal'} size={21} />
        </div>
        <p>
          {strategy.id === 'robust'
            ? 'Deduplicates event identities and rejects stale or conflicting snapshots.'
            : 'Applies every received snapshot, regardless of identity or revision.'}
        </p>
      </div>
      <div className="strategy-metrics">
        <div>
          <span>Applied writes</span>
          <strong>{strategy.metrics.applied}</strong>
        </div>
        <div>
          <span>Side effects</span>
          <strong>{strategy.metrics.sideEffects}</strong>
        </div>
        <div>
          <span>Duplicate effects</span>
          <strong>{strategy.metrics.duplicateEffects}</strong>
        </div>
      </div>
      <div className="order-states">
        <h4>Final order state</h4>
        {strategy.finalOrders.length ? (
          strategy.finalOrders.map((order) => (
            <div className="order-row" key={order.orderId}>
              <div>
                <strong className="mono">{order.orderId}</strong>
                <small>Revision {order.revision}</small>
              </div>
              <div className="order-value">
                <span className="order-status">{order.status}</span>
                <small>{number(order.totalCents)} cents</small>
              </div>
              <dl>
                <div>
                  <dt>Last event</dt>
                  <dd className="mono">{order.eventId}</dd>
                </div>
                <div>
                  <dt>Recorded at source</dt>
                  <dd>{order.occurredAt}</dd>
                </div>
              </dl>
            </div>
          ))
        ) : (
          <p className="empty-orders">No order state was written.</p>
        )}
        <p className="strategy-summary small">
          {strategy.metrics.duplicates} duplicates ignored · {strategy.metrics.stale} stale ·{' '}
          {strategy.metrics.conflicts} conflicts · {strategy.metrics.deadLetters} dead letters
        </p>
      </div>
    </section>
  );
}

function AttemptDetail({
  attempt,
  strategy,
  scenario,
}: {
  attempt?: Attempt;
  strategy: Strategy;
  scenario: Scenario;
}) {
  if (!attempt)
    return (
      <div className="attempt-detail">
        <p>No delivery attempts in this replay.</p>
      </div>
    );
  const event = scenario.events.find((item) => item.recordId === attempt.recordId);
  const next = strategy.attempts.find(
    (item) => item.deliveryId === attempt.deliveryId && item.attempt === attempt.attempt + 1,
  );
  const deadLetter = strategy.deadLetters.find((item) => item.deliveryId === attempt.deliveryId);
  const effects = strategy.effects.filter(
    (item) => item.deliveryId === attempt.deliveryId && item.timeMs === attempt.timeMs,
  );
  return (
    <section className="attempt-detail" aria-label="Selected delivery evidence">
      <span className="eyebrow">Attempt evidence</span>
      <h3 className="mono">{attempt.deliveryId}</h3>
      <p>
        Attempt {attempt.attempt} at virtual time {virtualTime(attempt.timeMs)}
      </p>
      <div className="detail-badges">
        <TransportBadge attempt={attempt} />
        <DecisionBadge decision={attempt.decision} />
      </div>
      <dl className="detail-grid">
        <div>
          <dt>Event identity</dt>
          <dd className="mono">{attempt.eventId}</dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd className="mono">{attempt.orderId}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{attempt.revision}</dd>
        </div>
        <div>
          <dt>Snapshot record</dt>
          <dd className="mono">{attempt.recordId}</dd>
        </div>
        <div>
          <dt>Side effects this attempt</dt>
          <dd>{effects.length}</dd>
        </div>
        <div>
          <dt>Next retry</dt>
          <dd>{next ? virtualTime(next.timeMs) : 'None'}</dd>
        </div>
      </dl>
      <div className="reason-block">
        <h4>Consumer decision</h4>
        <p>{attempt.reason}</p>
      </div>
      {next && (
        <div className="reason-block">
          <h4>Retry evidence</h4>
          <p>
            No delivery acknowledgement was received. The next attempt is scheduled{' '}
            {number(next.timeMs - attempt.timeMs)} ms later on the virtual clock.
          </p>
        </div>
      )}
      {deadLetter && !next && (
        <div className="reason-block">
          <h4>Dead-letter reason</h4>
          <p>{deadLetter.reason}</p>
        </div>
      )}
      <details className="raw-details">
        <summary>View simulated side effects</summary>
        <pre>{JSON.stringify(effects, null, 2)}</pre>
      </details>
      <details className="raw-details">
        <summary>View source snapshot</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
      <details className="raw-details">
        <summary>View raw attempt</summary>
        <pre>{JSON.stringify(attempt, null, 2)}</pre>
      </details>
    </section>
  );
}

function Results({ scenario, replay }: { scenario: Scenario; replay: ActiveReplay }) {
  const [strategyId, setStrategyId] = useState('robust');
  const [attemptKey, setAttemptKey] = useState('');
  const strategy =
    replay.result.strategies.find((item) => item.id === strategyId) ?? replay.result.strategies[0];
  const selected =
    strategy.attempts.find((item) => `${item.deliveryId}:${item.attempt}` === attemptKey) ??
    strategy.attempts[0];
  return (
    <>
      <div className="result-caption">
        <span className={`result-status ${!replay.savedId ? 'local' : ''}`}>
          <Icon name={replay.mode === 'server' ? 'cloud' : 'terminal'} size={15} />
          {replay.savedId
            ? 'Saved replay · Server result'
            : replay.mode === 'server'
              ? 'Server result · Not saved'
              : 'Local replay · Not saved'}
        </span>
        <p>Engine {replay.result.engineVersion} · Deterministic simulation</p>
      </div>
      {!!replay.result.warnings.length && (
        <details className="result-warnings">
          <summary>
            <Icon name="info" size={15} />
            <span>Simulation scope and assumptions</span>
            <Icon name="chevron" size={14} />
          </summary>
          <ul>
            {replay.result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="strategy-cards">
        {replay.result.strategies.map((item) => (
          <StrategyCard key={item.id} strategy={item} />
        ))}
      </div>
      <section className="timeline-panel" aria-label="Delivery attempts">
        <div className="timeline-toolbar">
          <div>
            <h3>Delivery attempts</h3>
            <p>Transport acknowledgement and consumer decision are separate.</p>
          </div>
          <div className="segmented" aria-label="Consumer strategy">
            {replay.result.strategies.map((item) => (
              <button
                key={item.id}
                className={strategy.id === item.id ? 'active' : ''}
                aria-pressed={strategy.id === item.id}
                onClick={() => setStrategyId(item.id)}
              >
                {item.id === 'robust' ? 'Guarded consumer' : 'Naive consumer'}
              </button>
            ))}
          </div>
        </div>
        <div className="timeline-layout">
          <div className="attempt-list">
            <div className="attempt-labels">
              <span>Virtual time</span>
              <span>Delivery / attempt</span>
              <span>Transport / decision</span>
            </div>
            {strategy.attempts.map((attempt) => {
              const key = `${attempt.deliveryId}:${attempt.attempt}`;
              const active =
                selected?.deliveryId === attempt.deliveryId &&
                selected?.attempt === attempt.attempt;
              return (
                <button
                  key={key}
                  className={`attempt-button ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() => setAttemptKey(key)}
                >
                  <span className="attempt-time mono">{virtualTime(attempt.timeMs)}</span>
                  <span className="attempt-identity">
                    <strong>{attempt.deliveryId}</strong>
                    <small>
                      Attempt {attempt.attempt} · rev {attempt.revision}
                    </small>
                  </span>
                  <span className="attempt-outcomes">
                    <TransportBadge attempt={attempt} />
                    <DecisionBadge decision={attempt.decision} />
                  </span>
                </button>
              );
            })}
          </div>
          <AttemptDetail attempt={selected} strategy={strategy} scenario={scenario} />
        </div>
        <div className="timeline-footnote">
          <Icon name="clock" size={16} />
          <p>
            {strategy.metrics.attempts} attempts · {strategy.metrics.received} received by the
            consumer. Retry delays advance a virtual clock; no waiting or network calls occur.
          </p>
        </div>
      </section>
      {!!strategy.deadLetters.length && (
        <section className="dead-letter-section">
          <h3>
            Dead-letter queue <span className="count-pill">{strategy.deadLetters.length}</span>
          </h3>
          {strategy.deadLetters.map((item) => (
            <div className="dead-letter-card" key={item.deliveryId}>
              <Icon name="info" />
              <div>
                <strong className="mono">{item.deliveryId}</strong>
                <p>
                  {item.reason} · {item.attempts} attempts · Last attempt{' '}
                  {virtualTime(item.lastTimeMs)}
                </p>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Method() {
  return (
    <>
      <div className="method-grid">
        <section className="method-card">
          <span className="eyebrow">01 / Explicit inputs</span>
          <h3>Order snapshots, not arbitrary webhooks.</h3>
          <p>
            Each snapshot declares an external event identity, order, revision, status, total in
            cents, and source timestamp. Deliveries reference these records and declare an injected
            transport fault.
          </p>
        </section>
        <section className="method-card">
          <span className="eyebrow">02 / Two consumers</span>
          <h3>Compare application behavior.</h3>
          <p>
            The naive consumer applies every received snapshot. The guarded consumer checks event
            identity and order revision to distinguish duplicate, stale, and conflicting payloads.
            Both receive the same delivery plan.
          </p>
        </section>
        <section className="method-card">
          <span className="eyebrow">03 / Virtual retries</span>
          <h3>A timeout does not prove failure.</h3>
          <p>
            A timeout after commit can produce a side effect even without an acknowledgement.
            Transient faults affect the first attempt; retries occur after 1 second, then 2 seconds.
            A permanently unavailable delivery exhausts three attempts.
          </p>
        </section>
        <section className="method-card">
          <span className="eyebrow">04 / Reproducible runs</span>
          <h3>Keep the input with the result.</h3>
          <p>
            Server replay validates, computes, and saves the scenario and versioned result together.
            Local replay uses the same engine on this device. Exports include the scenario; imported
            results are ignored and must be recomputed.
          </p>
        </section>
      </div>
      <div className="method-note">
        <h3>What this simulation can establish</h3>
        <p>
          Results describe these inputs and two bounded consumer strategies. Side effects are
          recorded simulation entries, not real payments or messages. This tool does not deliver
          webhooks, connect to production integrations, or establish exactly-once behavior in a
          distributed system. All bundled examples are synthetic.
        </p>
      </div>
    </>
  );
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario>(fixtures[0].scenario);
  const [replay, setReplay] = useState<ActiveReplay | null>(null);
  const [tab, setTab] = useState<Tab>('results');
  const [view, setView] = useState<'workbench' | 'library'>('workbench');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [running, setRunning] = useState<'server' | 'local' | null>(null);
  const [session, setSession] = useState<api.SessionInfo | null>(null);
  const [runs, setRuns] = useState<api.RunSummary[]>([]);
  const [storageBusy, setStorageBusy] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [busyRun, setBusyRun] = useState('');
  const [dialogOpener, setDialogOpener] = useState<HTMLElement | null>(null);
  const [editor, setEditor] = useState<'import' | 'edit' | null>(null);
  const [json, setJson] = useState('');
  const [importError, setImportError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<api.RunSummary | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const storageGeneration = useRef(0);
  const importGeneration = useRef(0);
  const [readingFile, setReadingFile] = useState(false);
  const main = useRef<HTMLElement>(null);
  const fixture = fixtures.find(
    (item) =>
      item.scenario === scenario ||
      (item.scenario.id === scenario.id &&
        JSON.stringify(item.scenario) === JSON.stringify(scenario)),
  );

  async function connectStorage() {
    const requestGeneration = ++storageGeneration.current;
    setStorageBusy(true);
    setStorageError('');
    try {
      const info = await api.ensureSession();
      const saved = await api.listRuns();
      if (requestGeneration !== storageGeneration.current) return;
      setSession(info);
      setRuns(saved);
    } catch (error) {
      if (requestGeneration === storageGeneration.current) setStorageError(errorMessage(error));
    } finally {
      if (requestGeneration === storageGeneration.current) setStorageBusy(false);
    }
  }
  useEffect(() => {
    void connectStorage();
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebar.current?.querySelector<HTMLElement>('a,button')?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        window.setTimeout(() => menuButton.current?.focus(), 0);
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const wide = window.matchMedia('(min-width: 761px)');
    const onResize = () => {
      if (wide.matches) {
        setSidebarOpen(false);
        window.setTimeout(() => main.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    wide.addEventListener('change', onResize);
    onResize();
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onResize);
      document.body.style.overflow = oldOverflow;
    };
  }, [sidebarOpen]);

  function closeNavigation(focusContent = false) {
    setSidebarOpen(false);
    if (sidebarOpen)
      window.setTimeout(() => (focusContent ? main.current : menuButton.current)?.focus(), 0);
  }
  function chooseScenario(next: Scenario, saved?: api.SavedRun) {
    generation.current += 1;
    setScenario(next);
    setReplay(
      saved
        ? { result: saved.result, mode: 'server', savedId: saved.id, createdAt: saved.createdAt }
        : null,
    );
    setView('workbench');
    setTab('results');
    setNotice(null);
    closeNavigation(true);
  }
  function navigate(next: 'workbench' | 'library', nextTab?: Tab) {
    generation.current += 1;
    setView(next);
    if (nextTab) setTab(nextTab);
    closeNavigation(true);
  }
  function closeEditor() {
    importGeneration.current += 1;
    setReadingFile(false);
    setEditor(null);
  }
  function openEditor(mode: 'import' | 'edit', opener: HTMLElement) {
    setDialogOpener(opener);
    generation.current += 1;
    importGeneration.current += 1;
    setReadingFile(false);
    setJson(mode === 'edit' ? JSON.stringify(scenario, null, 2) : '');
    setImportError('');
    setEditor(mode);
  }

  const exceedsSavedLimits =
    scenario.events.length > MAX_SAVED_EVENTS || scenario.deliveries.length > MAX_SAVED_DELIVERIES;

  async function run(mode: 'server' | 'local') {
    if (mode === 'server' && exceedsSavedLimits) return;
    setRunning(mode);
    setNotice(null);
    const currentGeneration = generation.current;
    try {
      if (mode === 'local') {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const result = replayScenario(scenario);
        if (currentGeneration === generation.current) {
          setReplay({ result, mode: 'local' });
          setTab('results');
        }
      } else {
        setSession(await api.ensureSession());
        const saved = await api.createRun(scenario);
        storageGeneration.current += 1;
        setStorageBusy(false);
        setRuns((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
        if (currentGeneration === generation.current) {
          setReplay({
            result: saved.result,
            mode: 'server',
            savedId: saved.id,
            createdAt: saved.createdAt,
          });
          setTab('results');
        }
        setStorageError('');
        if (currentGeneration === generation.current)
          setNotice({
            kind: 'success',
            text: 'Replay completed on the server and saved to your browser’s private library.',
          });
      }
    } catch (error) {
      if (currentGeneration === generation.current)
        setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setRunning(null);
    }
  }

  function importScenario() {
    setImportError('');
    try {
      const next = parseImport(json);
      chooseScenario(next);
      closeEditor();
      setJson('');
      setNotice({
        kind: 'info',
        text: 'Scenario loaded on this device. Any imported result was ignored. Choose Run and save to compute and save, or Run locally to keep it on this device.',
      });
    } catch (error) {
      setImportError(errorMessage(error));
    }
  }
  async function readFile(file?: File) {
    if (!file) return;
    const currentImport = ++importGeneration.current;
    setImportError('');
    setReadingFile(true);
    if (file.size > MAX_BUNDLE_BYTES) {
      setJson('');
      setImportError(
        'File exceeds 1 MiB. Use a raw scenario up to 64 KiB or an exported bundle up to 1 MiB.',
      );
      setReadingFile(false);
      return;
    }
    try {
      const text = decodeImportBytes(await file.arrayBuffer());
      if (currentImport === importGeneration.current) setJson(text);
    } catch (error) {
      if (currentImport === importGeneration.current) {
        setJson('');
        setImportError(errorMessage(error));
      }
    } finally {
      if (currentImport === importGeneration.current) setReadingFile(false);
    }
  }
  async function openRun(id: string) {
    const currentGeneration = ++generation.current;
    setBusyRun(id);
    setNotice(null);
    try {
      const saved = await api.loadRun(id);
      if (currentGeneration === generation.current) {
        chooseScenario(saved.scenario, saved);
        main.current?.focus();
      }
    } catch (error) {
      if (currentGeneration === generation.current)
        setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyRun('');
    }
  }
  async function exportRun(id: string) {
    setBusyRun(id);
    try {
      const saved = await api.loadRun(id);
      downloadBundle(saved.scenario, saved.result);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyRun('');
    }
  }
  async function deleteRun() {
    if (!deleteTarget) return;
    setBusyRun(deleteTarget.id);
    setNotice(null);
    try {
      await api.deleteRun(deleteTarget.id);
      storageGeneration.current += 1;
      setStorageBusy(false);
      setRuns((items) => items.filter((item) => item.id !== deleteTarget.id));
      setReplay((current) =>
        current?.savedId === deleteTarget.id ? { ...current, savedId: undefined } : current,
      );
      setDeleteTarget(null);
      setNotice({
        kind: 'success',
        text: 'Saved replay deleted. An already open result remains available locally.',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusyRun('');
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workbench
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => closeNavigation()}
        />
      )}
      <aside
        ref={sidebar}
        id="workspace-navigation"
        className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}
        aria-label="Main navigation"
        role={sidebarOpen ? 'dialog' : undefined}
        aria-modal={sidebarOpen ? true : undefined}
      >
        <a className="brand" href="#main-content" onClick={() => navigate('workbench')}>
          <span className="brand-mark">
            <Icon name="refresh" size={21} />
          </span>
          <span>
            Integration Replay<small>Lab / delivery workbench</small>
          </span>
        </a>
        <div className="side-label">Workspace</div>
        <nav className="side-nav">
          <button
            className={view === 'workbench' && tab !== 'method' ? 'active' : ''}
            onClick={() => navigate('workbench', 'results')}
          >
            <Icon name="terminal" />
            <span>Replay workbench</span>
          </button>
          <button
            className={view === 'library' ? 'active' : ''}
            onClick={() => navigate('library')}
          >
            <Icon name="folder" />
            <span>Saved replays</span>
            <small className="nav-count">{runs.length}</small>
          </button>
          <button
            className={view === 'workbench' && tab === 'method' ? 'active' : ''}
            onClick={() => navigate('workbench', 'method')}
          >
            <Icon name="info" />
            <span>How it works</span>
          </button>
        </nav>
        <div className="side-divider" />
        <div className="side-label">Fault scenarios</div>
        <div className="scenario-nav">
          {fixtures.map((item, index) => (
            <button
              key={item.id}
              className={fixture?.id === item.id && view === 'workbench' ? 'active' : ''}
              disabled={!!running}
              onClick={() => chooseScenario(item.scenario)}
            >
              <span className="scenario-number">{String(index + 1).padStart(2, '0')}</span>
              <span>
                <strong>{item.title}</strong>
                <small>Synthetic example</small>
              </span>
            </button>
          ))}
        </div>
        <p className="sidebar-caption">
          Deterministic scenarios.
          <br />
          No outbound webhooks.
        </p>
        <div className="sidebar-bottom">
          <div className="storage-status">
            <span
              className={`status-dot ${storageBusy ? '' : storageError ? 'offline' : 'online'}`}
            />
            {storageBusy
              ? 'Connecting to storage'
              : storageError
                ? 'Server unavailable'
                : 'Private browser session'}
          </div>
          <p>
            Saved replays expire after {session?.retentionDays ?? 30} days. Local replay stays on
            this device.
          </p>
        </div>
      </aside>
      <div className="main-shell" inert={sidebarOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={menuButton}
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{view === 'library' ? 'Saved replays' : 'Delivery simulation'}</strong>
          </div>
          <div className="topbar-note">
            <Icon name="clock" size={14} />
            Virtual retry clock
            <span className="version mono">v{replay?.result.engineVersion ?? '1.0.0'}</span>
          </div>
        </header>
        <main ref={main} tabIndex={-1} className="main-content" id="main-content">
          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <Icon name={notice.kind === 'success' ? 'check' : 'info'} />
              <p>{notice.text}</p>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {storageError && (
            <div className="storage-banner" role="status">
              <Icon name="info" />
              <p>{storageError}</p>
              <button
                className="text-button"
                onClick={() => void connectStorage()}
                disabled={storageBusy}
              >
                <Icon name="refresh" size={15} />
                {storageBusy ? 'Connecting…' : 'Retry connection'}
              </button>
            </div>
          )}
          {view === 'library' ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">Your replay history</span>
                  <h1>Saved replays</h1>
                  <p>Versioned results and the scenarios that produced them.</p>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() => void connectStorage()}
                  disabled={storageBusy}
                >
                  <Icon name="refresh" />
                  {storageBusy ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              <div className="privacy-banner">
                <Icon name="info" />
                <p>
                  Private to this browser’s anonymous cookie. Runs expire after{' '}
                  {session?.retentionDays ?? 30} days. Clearing or losing the cookie loses access.
                  Export important runs. Limit: {session?.maxRuns ?? 20} runs.
                </p>
              </div>
              {storageBusy ? (
                <div className="loading-state" role="status">
                  Loading saved replays…
                </div>
              ) : !runs.length ? (
                <div className="library-empty">
                  <span className="empty-icon">
                    <Icon name="folder" size={29} />
                  </span>
                  <h2>
                    {storageError
                      ? 'Your library could not be loaded'
                      : 'A place for repeatable investigations.'}
                  </h2>
                  <p>
                    {storageError
                      ? 'Retry the connection to view saved runs. Local replay remains available.'
                      : 'Run a scenario on the server to save its input and computed result here.'}
                  </p>
                  <button
                    className="button button-primary"
                    onClick={() => (storageError ? void connectStorage() : navigate('workbench'))}
                  >
                    {storageError ? 'Reconnect storage' : 'Open workbench'}
                    <Icon name="arrow" />
                  </button>
                </div>
              ) : (
                <div className="saved-list">
                  {runs.map((item) => (
                    <article className="saved-card" key={item.id}>
                      <span className="saved-icon">
                        <Icon name="file" size={22} />
                      </span>
                      <div className="saved-description">
                        <h2>
                          <button onClick={() => void openRun(item.id)} disabled={!!busyRun}>
                            {item.title}
                          </button>
                        </h2>
                        <p>
                          {item.origin === 'fixture' ? 'Declared fixture' : 'Imported scenario'}
                          <span>·</span>
                          {item.eventCount} snapshots<span>·</span>
                          {date(item.createdAt)}
                        </p>
                      </div>
                      <div className="saved-actions">
                        <button
                          className="button button-secondary"
                          disabled={!!busyRun}
                          onClick={() => void openRun(item.id)}
                        >
                          {busyRun === item.id ? 'Working…' : 'Open'}
                          <Icon name="arrow" size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Export ${item.title}`}
                          disabled={!!busyRun}
                          onClick={() => void exportRun(item.id)}
                        >
                          <Icon name="download" />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          aria-label={`Delete ${item.title}`}
                          disabled={!!busyRun}
                          onClick={(event) => {
                            setDialogOpener(event.currentTarget);
                            setNotice(null);
                            setDeleteTarget(item);
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">Faults in. Evidence out.</span>
                  <h1>Replay workbench</h1>
                  <p>
                    See what duplicates, delayed events, and lost acknowledgements do to order
                    state.
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button button-secondary"
                    disabled={!!running}
                    onClick={(event) => openEditor('import', event.currentTarget)}
                  >
                    <Icon name="upload" />
                    Import scenario
                  </button>
                </div>
              </div>
              <section className="scenario-card" aria-label="Selected scenario">
                <div className="scenario-card-body">
                  <span className="scenario-symbol">
                    <Icon name="layers" size={23} />
                  </span>
                  <div className="scenario-identity">
                    <div className="scenario-meta">
                      <span className="origin-tag">
                        {fixture ? 'Synthetic fixture' : 'Imported scenario'}
                      </span>
                      <span className="mono">{scenario.id}</span>
                    </div>
                    <h2>{scenario.title}</h2>
                    <p>
                      {fixture?.description ??
                        'An imported delivery plan. Its fields and injected faults are declared by the uploader.'}
                    </p>
                  </div>
                  <div className="scenario-tools">
                    <button
                      className="icon-button"
                      aria-label="Edit scenario JSON"
                      title="Edit scenario JSON"
                      disabled={!!running}
                      onClick={(event) => openEditor('edit', event.currentTarget)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Export JSON"
                      title="Export JSON"
                      onClick={() => downloadBundle(scenario, replay?.result)}
                    >
                      <Icon name="download" />
                    </button>
                  </div>
                </div>
                <div className="scenario-footer">
                  <div className="scenario-stats">
                    <span>
                      Snapshots <strong>{scenario.events.length}</strong>
                    </span>
                    <span>
                      Deliveries <strong>{scenario.deliveries.length}</strong>
                    </span>
                    <span>
                      Orders{' '}
                      <strong>{new Set(scenario.events.map((item) => item.orderId)).size}</strong>
                    </span>
                  </div>
                  <div className="run-actions">
                    <button
                      className="button button-secondary"
                      disabled={!!running}
                      onClick={() => void run('local')}
                    >
                      <Icon name="terminal" size={16} />
                      {running === 'local' ? 'Running locally…' : 'Run locally'}
                    </button>
                    <button
                      className="button button-primary"
                      disabled={!!running || exceedsSavedLimits}
                      aria-describedby={exceedsSavedLimits ? 'saved-run-limit' : undefined}
                      onClick={() => void run('server')}
                    >
                      <Icon name="play" size={16} />
                      {running === 'server' ? 'Running & saving…' : 'Run and save'}
                    </button>
                  </div>
                </div>
              </section>
              {exceedsSavedLimits && (
                <div className="storage-banner" role="status" id="saved-run-limit">
                  <Icon name="info" />
                  <p>
                    This scenario has {scenario.events.length} snapshots and{' '}
                    {scenario.deliveries.length} deliveries. Saved runs support up to{' '}
                    {MAX_SAVED_EVENTS} snapshots and {MAX_SAVED_DELIVERIES} deliveries. Run locally
                    and export this larger scenario, or reduce its size to save it.
                  </p>
                </div>
              )}
              <div className="privacy-note">
                <Icon name="info" size={15} />
                <p>
                  <strong>Run and save</strong> uploads the scenario and saves its result for{' '}
                  {session?.retentionDays ?? 30} days, private to this browser’s cookie. Remove
                  secrets and personal identifiers first. <strong>Run locally</strong> keeps the
                  scenario on this device. Saved runs support up to {MAX_SAVED_EVENTS} snapshots and{' '}
                  {MAX_SAVED_DELIVERIES} deliveries.
                </p>
              </div>
              <nav className="view-tabs" aria-label="Workbench sections">
                <button
                  className={tab === 'results' ? 'active' : ''}
                  aria-current={tab === 'results' ? 'page' : undefined}
                  onClick={() => setTab('results')}
                >
                  <Icon name="compare" size={17} />
                  Replay results
                </button>
                <button
                  className={tab === 'scenario' ? 'active' : ''}
                  aria-current={tab === 'scenario' ? 'page' : undefined}
                  onClick={() => setTab('scenario')}
                >
                  <Icon name="file" size={16} />
                  Scenario JSON
                </button>
                <button
                  className={tab === 'method' ? 'active' : ''}
                  aria-current={tab === 'method' ? 'page' : undefined}
                  onClick={() => setTab('method')}
                >
                  <Icon name="info" size={17} />
                  How it works
                </button>
                <span className="tab-note">{replay ? 'Replay complete' : 'Ready to simulate'}</span>
              </nav>
              {tab === 'method' ? (
                <Method />
              ) : tab === 'scenario' ? (
                <section className="raw-scenario">
                  <div className="section-heading">
                    <h3>Scenario input</h3>
                    <button
                      className="text-button"
                      disabled={!!running}
                      onClick={(event) => openEditor('edit', event.currentTarget)}
                    >
                      <Icon name="edit" size={15} />
                      Edit JSON
                    </button>
                  </div>
                  <p>
                    Only this validated scenario is sent for a server run. Existing results are not
                    accepted as input.
                  </p>
                  <pre>{JSON.stringify(scenario, null, 2)}</pre>
                </section>
              ) : replay ? (
                <Results
                  key={`${scenario.id}:${replay.savedId ?? 'local'}`}
                  scenario={scenario}
                  replay={replay}
                />
              ) : (
                <InputPreview scenario={scenario} />
              )}
              <footer className="workspace-footer">
                <span>
                  <span className="status-dot online" />
                  Simulated delivery · No outbound webhooks
                </span>
                <p>Transport success does not imply a state change.</p>
              </footer>
            </>
          )}
        </main>
      </div>
      {editor && (
        <Dialog
          title={editor === 'edit' ? 'Edit delivery scenario' : 'Import a scenario'}
          onClose={closeEditor}
          returnFocusTo={dialogOpener}
        >
          <p className="dialog-description">
            Paste a scenario or import an exported replay. Any included result is ignored. Loading
            an input does not run or save it.
          </p>
          <div className="file-picker">
            <Icon name="upload" size={24} />
            <div>
              <strong>Choose a JSON file</strong>
              <p>Raw scenario: 64 KiB. Export bundle: 1 MiB.</p>
            </div>
            <button className="button button-secondary" onClick={() => fileInput.current?.click()}>
              Browse files
            </button>
            <input
              ref={fileInput}
              type="file"
              className="visually-hidden"
              accept=".json,application/json"
              aria-label="Select scenario JSON file"
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
          <label className="input-label" htmlFor="scenario-json">
            Scenario JSON
          </label>
          <textarea
            id="scenario-json"
            className="json-input"
            value={json}
            onChange={(event) => {
              importGeneration.current += 1;
              setReadingFile(false);
              setImportError('');
              setJson(event.target.value);
            }}
            spellCheck={false}
            placeholder={
              '{\n  "schemaVersion": 1,\n  "id": "my-scenario",\n  "title": "Duplicate order update",\n  ...\n}'
            }
          />
          <div className="import-helper">
            <span>Download an example to inspect the supported schema.</span>
            <button className="text-button" onClick={() => downloadBundle(fixtures[0].scenario)}>
              <Icon name="download" size={14} />
              Example JSON
            </button>
          </div>
          {readingFile && (
            <p role="status" className="small">
              Reading file…
            </p>
          )}
          {importError && (
            <p className="form-error" role="alert">
              {importError}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button button-secondary" onClick={closeEditor}>
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={readingFile || !json.trim()}
              onClick={importScenario}
            >
              {readingFile
                ? 'Reading file…'
                : editor === 'edit'
                  ? 'Apply scenario'
                  : 'Import scenario'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </Dialog>
      )}
      {deleteTarget && (
        <Dialog
          title="Delete saved replay?"
          onClose={() => !busyRun && setDeleteTarget(null)}
          returnFocusTo={dialogOpener}
        >
          <p className="dialog-description">
            “{deleteTarget.title}” will be removed from server storage. Exported copies and any
            result already open in this workspace remain available.
          </p>
          {notice?.kind === 'error' && (
            <p className="form-error" role="alert">
              {notice.text}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              disabled={!!busyRun}
              onClick={() => setDeleteTarget(null)}
            >
              Keep replay
            </button>
            <button
              className="button button-danger"
              disabled={!!busyRun}
              onClick={() => void deleteRun()}
            >
              <Icon name="trash" size={16} />
              {busyRun ? 'Deleting…' : 'Delete replay'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
