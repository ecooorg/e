import React, { Component, ErrorInfo, useEffect, useMemo, useState, useCallback } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, BrainCircuit, Check, CircleHelp,
  Download, FlaskConical, Lock, Plus, ShieldAlert, Trash2, Upload,
} from 'lucide-react';
import {
  Decision, emptyDecision, STAGES, LOOPS, Step, Option, ExperimentCard,
  Hypothesis, NeutralItem, Unknown, uid, computeReviewDates, SCHEMA_VERSION,
  Level, Door, HumanDecision, JournalEntry,
} from './types/decision';
import {
  getStoredDecisions, saveDecisions, getActiveDecisionId, setActiveDecisionId,
  getPrivacyAccepted, setPrivacyAccepted, getMigrationReport, getArchived,
} from './utils/storage';
import { exportDecisionJson, exportAllJson, downloadBlob, parseImportedJson } from './utils/exportZip';
import { DISTRESS_MARKERS, SUPPORT_CONTACTS, hasDistressMarker, findDistressInTexts } from './config/support';
import { FEATURES, APP_VERSION } from './config';
import { en } from './i18n/en';
import { triage, TRIAGE_OUTCOME_TEXT, TRIAGE_OUTCOME_LABEL } from './core/triage';
import { evpi, evpiRange, evpiVerdict, validateEvpiInput } from './core/evpi';
import { brierScore } from './core/brier';
import { cardChecksum } from './core/sha256Export';
import { buildIcs } from './core/icsBuilder';

// --- API helper ---
function getToken(): string {
  return sessionStorage.getItem('be_app_token') || '';
}
function setToken(t: string) {
  sessionStorage.setItem('be_app_token', t);
}

async function api(path: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tok = getToken();
  if (tok) headers['x-app-token'] = tok;
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(j.error || `API error ${r.status}`);
  return j;
}

const stageIndex = (s: Step) => STAGES.findIndex((x) => x.id === s);

// --- Error boundary ---
class ErrorBoundary extends Component<
  { children: React.ReactNode; label?: string },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(_e: Error, _i: ErrorInfo) {}
  render() {
    if (this.state.error) {
      return (
        <div className="panel">
          <div className="alert error">
            <AlertCircle size={16} />
            <span>
              {this.props.label || 'Screen'} crashed with an error. Saved data was not deleted.
            </span>
          </div>
          <button className="primary" onClick={() => this.setState({ error: undefined })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Main App ---
export default function App() {
  const [decisions, setDecisions] = useState<Decision[]>(() => getStoredDecisions());
  const [activeId, setActiveId] = useState(() => getActiveDecisionId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [privacy, setPrivacy] = useState(() => getPrivacyAccepted());
  const [tokenInput, setTokenInput] = useState(getToken());
  const [showBrief, setShowBrief] = useState(false);
  const [expertMode, setExpertMode] = useState(false);
  const [migrationReport] = useState(() => getMigrationReport());

  const active = useMemo(
    () => decisions.find((d) => d.id === activeId) || decisions[0] || null,
    [decisions, activeId]
  );

  useEffect(() => {
    saveDecisions(decisions);
  }, [decisions]);
  useEffect(() => {
    if (active?.id) setActiveDecisionId(active.id);
  }, [active?.id]);

  const update = useCallback(
    (patch: Partial<Decision> | ((d: Decision) => Decision)) => {
      setDecisions((prev) =>
        prev.map((d) => {
          if (d.id !== (active?.id || '')) return d;
          const next = typeof patch === 'function' ? patch(d) : { ...d, ...patch };
          return { ...next, updatedAt: Date.now() };
        })
      );
    },
    [active?.id]
  );

  const createNew = () => {
    const d = emptyDecision();
    setDecisions((prev) => [d, ...prev]);
    setActiveId(d.id);
    setMessage('Ready — describe your situation below');
  };

  const removeDecision = (id: string) => {
    if (!confirm('Delete this decision?')) return;
    setDecisions((prev) => prev.filter((d) => d.id !== id));
    if (activeId === id) setActiveId('');
  };

  const runApi = async (path: string, body: unknown, onOk: (data: any, meta: any) => void) => {
    setBusy(true);
    setError('');
    try {
      const j = await api(path, body);
      onOk(j.data, j.meta);
      setMessage('Готово. Я обновил картину.');
    } catch (e: any) {
      setError(e.message || 'Error');
    } finally {
      setBusy(false);
    }
  };

  // --- Privacy / about gate ---
  if (!privacy) {
    return (
      <div className="shell">
        <div className="empty">
          <BrainCircuit size={40} />
          <h1>{en.app}</h1>
          <p>{en.subtitle}</p>
          <div className="panel" style={{ maxWidth: 560, textAlign: 'left' }}>
            <h2>{en.privacyTitle}</h2>
            <p>{en.privacyBody}</p>
            <p style={{ fontSize: 12, color: '#7f93aa' }}>
              Fields sent to Gemini API: Brief text, confirmed neutralization, answers to
              unknowns, options, hypotheses, experiment cards (no passwords or documents).
            </p>
            <label style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
              Access token (if the server requires APP_ACCESS_TOKEN):
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="optional"
                style={{ width: '100%', marginTop: 4 }}
              />
            </label>
            <button
              className="primary"
              style={{ marginTop: 16 }}
              onClick={() => {
                if (tokenInput) setToken(tokenInput);
                setPrivacyAccepted(true);
                setPrivacy(true);
              }}
            >
              {en.acceptPrivacy}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="shell">
        <Header
          onNew={createNew}
          onExportAll={() =>
            downloadBlob(exportAllJson(decisions), `bifurcation_v11_${Date.now()}.json`)
          }
          onImport={(file) => {
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const list = parseImportedJson(String(reader.result));
                setDecisions((prev) => [...list, ...prev]);
                setMessage(`Imported: ${list.length}`);
              } catch (e: any) {
                setError(e.message);
              }
            };
            reader.readAsText(file);
          }}
        />
        <div className="empty">
          <h1>Nothing here yet</h1>
          <p>Расскажите о ситуации своими словами — не нужно заранее структурировать её.</p>
          <button className="primary" onClick={createNew}>
            <Plus size={16} /> Новое решение
          </button>
          {migrationReport.length > 0 && (
            <div className="panel" style={{ marginTop: 20, textAlign: 'left', maxWidth: 500 }}>
              <h3>Migration report</h3>
              <ul>
                {migrationReport.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              {getArchived() && (
                <button
                  className="ghost"
                  onClick={() => {
                    const blob = new Blob([getArchived() || ''], { type: 'application/json' });
                    downloadBlob(blob, 'archive_v5_v6.json');
                  }}
                >
                  Download archive of old data
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const d = active;
  const si = stageIndex(d.step);
  const stageMeta = STAGES[si] || STAGES[0];

  return (
    <div className="shell">
      <Header
        title={d.title}
        onNew={createNew}
        onExport={() =>
          downloadBlob(exportDecisionJson(d), `${d.title.slice(0, 40) || d.id}.json`)
        }
        onExportAll={() =>
          downloadBlob(exportAllJson(decisions), `bifurcation_v11_${Date.now()}.json`)
        }
        onImport={(file) => {
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const list = parseImportedJson(String(reader.result));
              setDecisions((prev) => [...list, ...prev]);
              setMessage(`Imported: ${list.length}`);
            } catch (e: any) {
              setError(e.message);
            }
          };
          reader.readAsText(file);
        }}
        onBrief={() => setShowBrief(true)}
        onDelete={() => removeDecision(d.id)}
        expertMode={expertMode}
        onToggleExpert={() => setExpertMode((v) => !v)}
      />
      <div className={`layout ${expertMode ? '' : 'friendly-layout'}`}>
        {expertMode && <aside className="sidebar">
          <div className="brand">
            <BrainCircuit size={14} /> Cycle {d.cycleCount}
          </div>
          <div className="stages">
            {STAGES.map((s, i) => (
              <button
                key={s.id}
                className={`stage ${d.step === s.id ? 'current' : ''} ${i < si ? 'done' : ''}`}
                disabled={i > si}
                onClick={() => {
                  if (i <= si) update({ step: s.id });
                }}
              >
                <span>{i + 1}</span>
                <div>
                  <b>{s.label}</b>
                  <small>{s.loop}</small>
                </div>
              </button>
            ))}
          </div>
          <div className="sidebar-note">
            {en.formula}
            <br />
            <br />
            Human decision:{' '}
            {d.decision ? 'recorded' : 'not yet'}
          </div>
          {/* Loop stepper */}
          <div style={{ marginTop: 12, padding: '0 7px' }}>
            {LOOPS.map((l) => (
              <div
                key={l.id}
                style={{
                  fontSize: 10,
                  color: l.steps.includes(d.step) ? '#dcecff' : '#53687d',
                  marginBottom: 4,
                }}
              >
                {l.id}. {l.label}
              </div>
            ))}
          </div>
        </aside>}

        <main className="content">
          {!expertMode ? (
            <div className="friendly-topbar">
              <div>
                <div className="eyebrow">BIFURCATION</div>
                <h1>Ваше решение</h1>
                <div className="friendly-status">
                  {d.options.length ? `${d.options.length} вариантов` : 'Собираем контекст'}
                  {d.radar?.unknowns?.length ? ` · ${d.radar.unknowns.filter((u) => u.critical && !u.answer).length} важных неизвестных` : ''}
                </div>
              </div>
              {busy && <div className="alert info"><div className="spinner" /> Разбираюсь…</div>}
            </div>
          ) : (
            <div className="topline">
              <div>
                <div className="stagebar"><span>Loop · {stageMeta.loop} · {stageMeta.article}</span></div>
                <h1 style={{ margin: '8px 0 4px', fontSize: 22 }}>{stageMeta.label}</h1>
                <div style={{ fontSize: 12, color: '#7f93aa' }}>
                  <b>{en.human}:</b> {stageMeta.human}<br />
                  <b>{en.model}:</b> {stageMeta.model}
                </div>
              </div>
              {busy && <div className="alert"><div className="spinner" /> Requesting model…</div>}
            </div>
          )}

          {error && (
            <div className="alert error">
              <AlertCircle size={16} /> {error}
              <button className="ghost" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {message && (
            <div className="alert">
              <Check size={16} /> {message}
              <button className="ghost" onClick={() => setMessage('')}>
                ×
              </button>
            </div>
          )}

          <ErrorBoundary label={stageMeta.label}>
            {d.step === 'TRIAGE' && (
              <TriageScreen
                d={d}
                update={update}
                onContinue={() => update({ step: 'BRIEF' })}
              />
            )}
            {d.step === 'BRIEF' && (
              <BriefScreen
                d={d}
                update={update}
                runApi={runApi}
                busy={busy}
              />
            )}
            {d.step === 'UNDERSTAND' && (
              <UnderstandScreen d={d} update={update} runApi={runApi} busy={busy} />
            )}
            {d.step === 'EXPAND' && (
              <ExpandScreen d={d} update={update} runApi={runApi} busy={busy} />
            )}
            {d.step === 'ATTACK' && (
              <AttackScreen d={d} update={update} runApi={runApi} busy={busy} />
            )}
            {d.step === 'TEST' && (
              <TestScreen d={d} update={update} runApi={runApi} busy={busy} />
            )}
            {d.step === 'DECIDE' && (
              <DecideScreen d={d} update={update} runApi={runApi} />
            )}
            {d.step === 'SYNTHESIS' && (
              <SynthesisScreen d={d} update={update} runApi={runApi} busy={busy} />
            )}
            {d.step === 'LEARN' && (
              <LearnScreen
                d={d}
                update={update}
                runApi={runApi}
                onNextCycle={() => {
                  const next = emptyDecision();
                  next.parentCycleId = d.id;
                  next.cycleCount = (d.cycleCount || 1) + 1;
                  next.title = `${d.title || 'Decision'} · cycle ${next.cycleCount}`;
                  // Carry results back to the start (article §4 contour 5 / §9 item 11)
                  const learnedFacts = d.journal
                    .filter((j) => j.fact?.trim())
                    .map((j) => `Fact (cycle ${d.cycleCount}): ${j.fact}`);
                  const updatedNotes = d.journal
                    .filter((j) => j.whatIUpdated?.trim())
                    .map((j) => j.whatIUpdated!);
                  next.brief = {
                    ...emptyDecision().brief,
                    decision: d.brief.decision,
                    goal: d.brief.goal,
                    deadline: d.brief.deadline,
                    facts: [
                      ...(d.brief.facts || []),
                      ...learnedFacts,
                    ],
                    values: [...(d.brief.values || [])],
                    myOptions: [...(d.brief.myOptions || [])],
                    constraints: [...(d.brief.constraints || [])],
                    assumptions: [
                      ...(d.brief.assumptions || []),
                      ...updatedNotes.map((n) => `Updated: ${n}`),
                    ],
                    errorCost: {
                      preliminary: d.brief.errorCost?.final || d.brief.errorCost?.preliminary,
                    },
                    reversibility: {
                      preliminary:
                        d.brief.reversibility?.final || d.brief.reversibility?.preliminary,
                    },
                  };
                  // Keep journal history for calibration across cycles
                  next.journal = d.journal.map((j) => ({ ...j }));
                  setDecisions((prev) => [next, ...prev]);
                  setActiveId(next.id);
                  setActiveDecisionId(next.id);
                }}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>

      {showBrief && (
        <BriefPanel d={d} onClose={() => setShowBrief(false)} update={update} />
      )}
    </div>
  );
}

// --- Header ---
function Header(props: {
  title?: string;
  onNew: () => void;
  onExport?: () => void;
  onExportAll: () => void;
  onImport: (f: File) => void;
  onBrief?: () => void;
  onDelete?: () => void;
  expertMode?: boolean;
  onToggleExpert?: () => void;
}) {
  return (
    <header className="header">
      <div className="logo">
        <div className="logo-mark">BE</div>
        <div>
          <b>{en.app}</b>
          <small>
            {en.subtitle} · {APP_VERSION}
            {props.title ? ` · ${props.title}` : ''}
          </small>
        </div>
      </div>
      <div className="header-actions">
        {props.onBrief && <button className="ghost" onClick={props.onBrief}>Что уже известно</button>}
        <button className="ghost" onClick={props.onNew}><Plus size={14} /> Новое</button>
        {props.onToggleExpert && <button className="ghost" onClick={props.onToggleExpert}>{props.expertMode ? 'Обычный режим' : 'Методика'}</button>}
        {props.onExport && (
          <button className="ghost" onClick={props.onExport}>
            <Download size={14} /> Экспорт
          </button>
        )}
        <button className="ghost" onClick={props.onExportAll}>
          <Download size={14} /> Всё
        </button>
        <label className="ghost" style={{ cursor: 'pointer' }}>
          <Upload size={14} /> Импорт
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) props.onImport(f);
            }}
          />
        </label>
        {props.onDelete && (
          <button className="ghost danger" onClick={props.onDelete}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </header>
  );
}

// --- TRIAGE ---
function TriageScreen({
  d,
  update,
  onContinue,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  onContinue: () => void;
}) {
  const t = d.triage || {
    crisis: false,
    onlyValues: false,
    q: { costly: false, hardToUndo: false, resolvableUnknowns: false, longHorizon: false },
    outcome: 'OVERKILL' as const,
  };

  const setT = (patch: Partial<typeof t>) => {
    const next = { ...t, ...patch };
    if (patch.q) next.q = { ...t.q, ...patch.q };
    const outcome = triage({
      crisis: next.crisis,
      onlyValues: next.onlyValues,
      ...next.q,
    });
    next.outcome = outcome;
    update({ triage: next });
  };

  // Quick start: if user needs urgent help — stop. No protocol.
  const crisisBlocked = !!t.crisis;

  return (
    <div className="panel">
      <h2>
        <ShieldAlert size={18} /> Safety and fit check
      </h2>
      <div className="alert" style={{ marginBottom: 16 }}>
        <strong>{en.crisisTitle}</strong>
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button
            className={t.crisis ? 'primary' : 'ghost'}
            onClick={() => setT({ crisis: true, crisisConfirmed: false })}
          >
            Yes
          </button>
          <button
            className={!t.crisis ? 'primary' : 'ghost'}
            onClick={() => setT({ crisis: false, crisisConfirmed: false })}
          >
            No
          </button>
        </div>
      </div>
      {t.crisis && (
        <div className="alert error">
          <strong>Please pause.</strong> {en.crisisYes}
          {SUPPORT_CONTACTS.length > 0 && (
            <ul>
              {SUPPORT_CONTACTS.map((c, i) => (
                <li key={i}>
                  {c.label}: {c.value}
                </li>
              ))}
            </ul>
          )}
          <p style={{ marginTop: 8, fontSize: 13 }}>
            Do not use this decision tool in this state. If things improve, come back and answer “No”.
          </p>
        </div>
      )}
      {!crisisBlocked && (
        <>
          <div className="triage-grid" style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            {(
              [
                ['costly', 'Would a wrong choice cost a lot (money, time, relationships, or health)?'],
                ['hardToUndo', 'Would it be hard or expensive to undo?'],
                ['resolvableUnknowns', 'Are there important things you can still find out?'],
                ['longHorizon', 'Could the effects last a long time (years, not weeks)?'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={t.q[key]}
                  onChange={(e) => setT({ q: { ...t.q, [key]: e.target.checked } })}
                />
                {label}
              </label>
            ))}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={t.onlyValues}
                onChange={(e) => setT({ onlyValues: e.target.checked })}
              />
              This is only about personal values; there is nothing factual to check
            </label>
          </div>
          <div className="alert" style={{ marginTop: 16 }}>
            Result: <b>{TRIAGE_OUTCOME_LABEL[t.outcome]}</b> — {TRIAGE_OUTCOME_TEXT[t.outcome]}
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <button
              className="primary"
              disabled={crisisBlocked}
              onClick={() => {
                update({
                  triage: { ...t, confirmed: true },
                  brief: {
                    ...d.brief,
                    errorCost: {
                      ...d.brief.errorCost,
                      preliminary: t.q.costly ? 'HIGH' : 'LOW',
                    },
                    reversibility: {
                      ...d.brief.reversibility,
                      preliminary: t.q.hardToUndo ? 'ONE_WAY' : 'TWO_WAY',
                    },
                  },
                });
                onContinue();
              }}
            >
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- BRIEF ---

function BriefScreen({
  d,
  update,
  runApi,
  busy,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  busy: boolean;
}) {
  const b = d.brief;
  const [showMore, setShowMore] = useState(false);
  const [showFit, setShowFit] = useState(false);
  const setB = (patch: Partial<typeof b>) =>
    update({ brief: { ...b, ...patch } });

  const distress = findDistressInTexts([
    b.decision,
    b.goal,
    ...(b.facts || []),
    ...(b.unknowns || []),
  ]);

  const tState = d.triage || {
    crisis: false,
    onlyValues: false,
    q: { costly: false, hardToUndo: false, resolvableUnknowns: false, longHorizon: false },
    outcome: 'OVERKILL' as const,
  };

  const setTriageQ = (key: keyof typeof tState.q, val: boolean) => {
    const q = { ...tState.q, [key]: val };
    const outcome = triage({
      crisis: !!tState.crisis,
      onlyValues: !!tState.onlyValues,
      ...q,
    });
    update({
      triage: { ...tState, q, outcome, confirmed: true },
    });
  };

  const canContinue = (b.decision || '').trim().length >= 10;

  const handleContinue = () => {
    if (!canContinue || busy || tState.crisis) return;
    const existing = d.triage;
    update({
      title: b.decision.trim().slice(0, 80) || d.title,
      triage: existing?.confirmed ? existing : {
        crisis: false, onlyValues: false,
        q: { costly: false, hardToUndo: false, resolvableUnknowns: true, longHorizon: false },
        outcome: 'METHOD_JUSTIFIED', confirmed: true,
      },
    });
    runApi('/api/preview', { decision: b.decision, goal: b.goal, deadline: b.deadline }, (data) => {
      update({
        modelSuggestions: { ...d.modelSuggestions, preview: data },
        step: 'UNDERSTAND',
        interactionState: 'PREVIEW_READY',
      });
    });
  };

  return (
    <div className="welcome-flow">
      <div className="welcome-hero">
        <h2 style={{ marginTop: 0 }}>{en.welcomeTitle}</h2>
        <p className="welcome-hint">{en.welcomeHint}</p>
        <label className="story-label">{en.decision}</label>
        <textarea
          className="story-input"
          rows={6}
          placeholder={en.startWriting}
          value={b.decision}
          onChange={(e) => {
            const v = e.target.value;
            setB({ decision: v });
            update({ title: v.slice(0, 80) || d.title });
          }}
        />
        <Field
          label={en.deadline}
          value={b.deadline || ''}
          onChange={(v) => setB({ deadline: v })}
        />
      </div>

      <div className="safety-inline">
        <div>Если это связано с непосредственной угрозой вашей безопасности, сначала лучше обратиться к человеку или экстренной помощи.</div>
        <div className="mini-actions">
          <button className={tState.crisis ? 'selected' : ''} onClick={() => update({ triage: { ...tState, crisis: true, confirmed: true, outcome: 'CRISIS_STOP' } })}>Да, сейчас есть такая угроза</button>
          <button className={!tState.crisis ? 'selected' : ''} onClick={() => update({ triage: { ...tState, crisis: false } })}>Нет</button>
        </div>
      </div>
      {tState.crisis && (
        <div className="alert error">
          Пожалуйста, остановитесь и обратитесь к реальному человеку или местной службе помощи. Этот инструмент не предназначен для кризисных ситуаций.
        </div>
      )}
      {distress && !tState.crisis && (
        <div className="alert error">
          В тексте есть признаки сильного напряжения. Если есть непосредственная угроза безопасности, выберите «Да» выше.
        </div>
      )}

      <div className="optional-block">
        <button type="button" className="ghost" onClick={() => setShowMore((s) => !s)}>
          {showMore ? en.hideOptional : en.showOptional}
        </button>
        {showMore && (
          <div className="formgrid" style={{ marginTop: 12 }}>
            <Field label={en.goal} value={b.goal || ''} onChange={(v) => setB({ goal: v })} />
            <ListField label={en.facts} items={b.facts} onChange={(facts) => setB({ facts })} />
            <ListField
              label={en.unknowns}
              items={b.unknowns}
              onChange={(unknowns) => setB({ unknowns })}
            />
            <ListField
              label={en.assumptions}
              items={b.assumptions}
              onChange={(assumptions) => setB({ assumptions })}
            />
            <ListField label={en.values} items={b.values} onChange={(values) => setB({ values })} />
            <ListField
              label={en.constraints}
              items={b.constraints}
              onChange={(constraints) => setB({ constraints })}
            />
            <div>
              <label>{en.myOptions}</label>
              {b.myOptions.map((o, i) => (
                <div key={o.id} style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <input
                    value={o.title}
                    onChange={(e) => {
                      const myOptions = [...b.myOptions];
                      myOptions[i] = { ...o, title: e.target.value };
                      setB({ myOptions });
                    }}
                  />
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => setB({ myOptions: b.myOptions.filter((x) => x.id !== o.id) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="ghost"
                type="button"
                style={{ marginTop: 6 }}
                onClick={() =>
                  setB({ myOptions: [...b.myOptions, { id: uid('opt'), title: '' }] })
                }
              >
                <Plus size={14} /> Add option
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="optional-block">
        <button type="button" className="ghost" onClick={() => setShowFit((s) => !s)}>
          {en.fitTitle}
        </button>
        {showFit && (
          <div style={{ marginTop: 10 }}>
            <p className="welcome-hint">{en.fitHint}</p>
            <div className="triage-grid" style={{ display: 'grid', gap: 10 }}>
              {(
                [
                  ['costly', 'Would a wrong choice cost a lot (money, time, relationships, or health)?'],
                  ['hardToUndo', 'Would it be hard or expensive to undo?'],
                  ['resolvableUnknowns', 'Are there important things you can still find out?'],
                  ['longHorizon', 'Could the effects last a long time (years, not weeks)?'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={!!tState.q?.[key]}
                    onChange={(e) => setTriageQ(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {d.triage?.confirmed && (
              <div className="alert" style={{ marginTop: 12 }}>
                Result: <b>{TRIAGE_OUTCOME_LABEL[d.triage.outcome]}</b> —{' '}
                {TRIAGE_OUTCOME_TEXT[d.triage.outcome]}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="actions" style={{ marginTop: 20 }}>
        <button className="primary" disabled={!canContinue} onClick={handleContinue}>
          Разобраться <ArrowRight size={16} />
        </button>
        {!canContinue && (
          <span style={{ fontSize: 12, color: '#7f93aa', marginLeft: 8 }}>
            Write at least a short description to continue
          </span>
        )}
      </div>
    </div>
  );
}


function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label>
        {label}
        {required ? '' : ''}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        style={{ width: '100%' }}
      />
    </div>
  );
}

function ListField({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div>
      <label>{label}</label>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <input
            value={it}
            onChange={(e) => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
            style={{ flex: 1 }}
          />
          <button className="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="ghost" style={{ marginTop: 6 }} onClick={() => onChange([...items, ''])}>
        <Plus size={14} />
      </button>
    </div>
  );
}

// --- UNDERSTAND ---
function UnderstandScreen({
  d,
  update,
  runApi,
  busy,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const preview: any = d.modelSuggestions?.preview;
  const unknowns = d.radar?.unknowns || [];
  const open = unknowns.filter((u) => u.critical && !u.discarded && !u.answer && u.status !== 'USER_UNKNOWN' && u.status !== 'ACCEPTED_UNCERTAINTY');
  const current = open[Math.min(questionIndex, Math.max(0, open.length - 1))];

  useEffect(() => {
    if (d.radar || busy || !d.brief.decision) return;
    runApi('/api/understand', { brief: d.brief, preview }, (data, meta) => {
      const mapClaim = (c: any, kind: string) => ({
        id: c.id || uid('c'), kind: kind as any, text: c.text || '', source: c.source || 'USER_DATA',
        sourceType: 'MODEL' as const, status: 'UNRESOLVED' as const, evidenceIds: [],
        createdAt: Date.now(), updatedAt: Date.now(), userImportance: c.userImportance,
      });
      const radar = {
        facts: (data.radar?.facts || []).map((c: any) => mapClaim(c, 'FACT')),
        assumptions: (data.radar?.assumptions || []).map((c: any) => mapClaim(c, 'ASSUMPTION')),
        interpretations: (data.radar?.interpretations || []).map((c: any) => mapClaim(c, 'INTERPRETATION')),
        values: (data.radar?.values || []).map((c: any) => mapClaim(c, 'VALUE')),
        needsExternalCheck: (data.radar?.needsExternalCheck || []).map((c: any) => mapClaim(c, 'EXTERNAL_VERIFY')),
        unknowns: (data.radar?.unknowns || []).map((u: any) => ({
          id: u.id || uid('u'), kind: 'UNKNOWN' as const, text: u.question || '', source: u.source || 'USER_DATA',
          sourceType: 'MODEL' as const, status: 'UNRESOLVED' as const, evidenceIds: [], createdAt: Date.now(), updatedAt: Date.now(),
          question: u.question || '', whyChangesDecision: u.whyChangesDecision || '', howToFindOut: u.howToFindOut || '',
          effort: u.effort || 'DAYS', branchIfA: u.branchIfA || { answer: '', leadsTo: '' }, branchIfB: u.branchIfB || { answer: '', leadsTo: '' },
          critical: !!u.critical, owner: u.owner || 'You',
        })),
        meta,
      };
      update({
        neutralization: (data.neutralization || []).map((it: any, i: number) => ({ id: it.id || uid('n'), original: it.original || '', kind: it.kind || 'KEEP', neutralQuestion: it.neutralQuestion, userChoice: 'ACCEPT' as const })),
        neutralizationConfirmed: true,
        radar,
        interactionState: 'UNDERSTANDING',
        modelSuggestions: { ...d.modelSuggestions, preview: data.preview || preview },
      });
    });
  }, [d.radar, busy, d.brief.decision]);

  const resolveCurrent = (status: 'ANSWER' | 'UNKNOWN' | 'ACCEPT') => {
    if (!current) return;
    const next = unknowns.map((u) => u.id === current.id ? {
      ...u,
      status: status === 'ANSWER' ? 'USER_CONFIRMED' as const : status === 'UNKNOWN' ? 'USER_UNKNOWN' as const : 'ACCEPTED_UNCERTAINTY' as const,
      answer: status === 'ANSWER' ? answer.trim() : undefined,
      owner: u.owner || 'You',
    } : u);
    update({ radar: { ...d.radar!, unknowns: next } });
    setAnswer('');
    setQuestionIndex(0);
  };

  const goToOptions = () => {
    if (!d.radar) return;
    runApi('/api/knowledge-map', { brief: d.brief, radar: d.radar }, (km, meta) => {
      runApi('/api/expand', { brief: d.brief, knowledgeMap: { ...km, meta, confirmed: true }, myOptions: d.brief.myOptions }, (data) => {
        const modelOpts: Option[] = (data.options || []).map((o: any) => ({
          id: o.id || uid('opt'), title: o.title || '', description: o.description || '', byUser: false,
          kind: o.kind, keyAssumption: o.keyAssumption || '', exitCost: o.exitCost || '', cheapestTest: o.cheapestTest || '',
          door: o.door || 'TWO_WAY', realistic: 'UNKNOWN' as const, linkedUnknownIds: o.linkedUnknownIds || [],
        }));
        const userOpts = d.brief.myOptions.filter((o) => o.title.trim()).map((o) => ({
          id: o.id, title: o.title, description: '', byUser: true, keyAssumption: '', exitCost: '', cheapestTest: '', door: 'TWO_WAY' as Door, realistic: 'YES' as const, linkedUnknownIds: [],
        }));
        update({ knowledgeMap: { ...km, meta, confirmed: true }, options: [...userOpts, ...modelOpts], step: 'EXPAND', interactionState: 'OPTIONS_READY' });
      });
    });
  };

  return (
    <div className="friendly-flow">
      {preview && (
        <div className="panel hero">
          <div className="panel-title"><div><h2>Пока я вижу ситуацию так</h2><p>Это предварительная картина, а не рекомендация.</p></div></div>
          {preview.summary && <p className="lead-text">{preview.summary}</p>}
          {Array.isArray(preview.possibilities) && preview.possibilities.length > 0 && (
            <div className="preview-options">{preview.possibilities.map((x: string, i: number) => <div className="preview-chip" key={i}>{x}</div>)}</div>
          )}
        </div>
      )}
      <div className="panel">
        <h2>Что сейчас важно понять</h2>
        <p>Я не пытаюсь выбрать за вас. Сначала отделю известное от предположений и найду то, что действительно может изменить картину.</p>
        {!d.radar && <div className="alert info"><div className="spinner" /> Собираю контекст…</div>}
        {d.radar && <>
          <div className="epistemic-grid">
            {([['facts','Факты'],['assumptions','Предположения'],['interpretations','Интерпретации'],['values','Что важно вам']] as const).map(([k,label]) => (
              <div className="epistemic-box" key={k}><b>{label}</b>{((d.radar as any)[k] || []).slice(0,4).map((c: any, i: number) => <p key={i}>{c.text}</p>)}</div>
            ))}
          </div>
          {current ? (
            <div className="decision-question">
              <div className="eyebrow">ВОПРОС, КОТОРЫЙ МОЖЕТ ИЗМЕНИТЬ РЕШЕНИЕ</div>
              <h3>{current.question}</h3>
              <p>{current.whyChangesDecision}</p>
              <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Ваш ответ…" rows={3} />
              <div className="actions">
                <button className="primary" disabled={!answer.trim() || busy} onClick={() => resolveCurrent('ANSWER')}>Ответить</button>
                <button className="ghost" disabled={busy} onClick={() => resolveCurrent('UNKNOWN')}>Не знаю</button>
                <button className="ghost" disabled={busy} onClick={() => resolveCurrent('ACCEPT')}>Принять неопределённость</button>
              </div>
            </div>
          ) : (
            <div className="alert info">Критических неизвестных больше нет. Теперь можно расширить пространство вариантов.</div>
          )}
          {d.radar.needsExternalCheck?.length > 0 && <div className="compact-note"><b>Потребует внешней проверки:</b> {d.radar.needsExternalCheck.map((x) => x.text).join(' · ')}</div>}
          {!current && <button className="primary" disabled={busy} onClick={goToOptions}>Посмотреть возможные пути <ArrowRight size={16} /></button>}
        </>}
      </div>
    </div>
  );
}

// --- EXPAND ---
function ExpandScreen({ d, update, runApi, busy }: { d: Decision; update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void; runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void; busy: boolean; }) {
  const visible = d.options.filter((o) => o.realistic !== 'NO');
  return (
    <div className="friendly-flow">
      <div className="panel hero">
        <h2>Возможные пути</h2>
        <p>Я не ранжирую их и не говорю, какой лучше. Цель — убедиться, что вы не застряли в исходном A/B.</p>
        <div className="cards">{d.options.map((o) => (
          <div key={o.id} className="card option-card">
            <div className="optiontop"><span className="pill">{o.byUser ? 'ВАШ ВАРИАНТ' : (o.kind || 'АЛЬТЕРНАТИВА').replaceAll('_',' ')}</span></div>
            <h3>{o.title}</h3><p>{o.description}</p>
            <details><summary>Почему это стоит рассмотреть</summary><div className="option-detail">{o.keyAssumption && <p><b>Что должно быть правдой:</b> {o.keyAssumption}</p>}{o.exitCost && <p><b>Цена выхода:</b> {o.exitCost}</p>}{o.cheapestTest && <p><b>Дешёвая проверка:</b> {o.cheapestTest}</p>}</div></details>
            <label className="realistic-row">Насколько это реально для вас?
              <select value={o.realistic} onChange={(e) => update({ options: d.options.map((x) => x.id === o.id ? { ...x, realistic: e.target.value as Option['realistic'] } : x) })}>
                <option value="YES">реально</option><option value="UNKNOWN">не знаю</option><option value="NO">не подходит</option>
              </select>
            </label>
          </div>
        ))}</div>
        <div className="actions">
          <button className="primary" disabled={visible.length < 2} onClick={() => update({ step: 'ATTACK', interactionState: 'ATTACK_READY' })}>Проверить слабые места <ArrowRight size={16} /></button>
          <button className="ghost" onClick={() => update({ step: 'SYNTHESIS', interactionState: 'USER_SATISFIED' })}>Мне пока достаточно</button>
        </div>
      </div>
    </div>
  );
}

// --- ATTACK ---
function AttackScreen({
  d,
  update,
  runApi,
  busy,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  busy: boolean;
}) {
  const real = d.options.filter((o) => o.realistic !== 'NO');
  // Prefer leaning from Brief if preferred not yet set
  const preferred = real.find((o) => o.id === d.preferredOptionId) || real[0];
  const opposite = real.find((o) => o.id === d.oppositeOptionId) || real.find((o) => o.id !== preferred?.id);
  const preferredId = preferred?.id;
  const bothDone =
    d.redTeam.some((r) => r.role === 'PREFERRED') &&
    d.redTeam.some((r) => r.role === 'OPPOSITE');
  const allAnswered =
    bothDone &&
    d.redTeam.every((r) =>
      r.objections.every((o) => o.response?.verdict && o.response?.reason)
    );
  const selectedHyps = d.hypotheses.filter((h) => h.selectedByUser);

  return (
    <div>
      <div className="panel hero">
        <h2>Что может сломать эти варианты?</h2>
        <p>Я автоматически атакую два существенных пути симметрично. Вы не обязаны заранее объявлять фаворита.</p>
        <div className="attack-pair"><div><b>{preferred?.title || '—'}</b><small>первый существенный вариант</small></div><div><b>{opposite?.title || '—'}</b><small>сильная альтернатива</small></div></div>
        <button className="primary" disabled={busy || !preferred || !opposite || (d.redTeam.length >= 2)} onClick={() => {
          if (!preferred || !opposite) return;
          runApi('/api/redteam', { brief: d.brief, option: preferred, role: 'PREFERRED', radar: d.radar, knowledgeMap: d.knowledgeMap }, (data, meta) => {
            const round = { targetOptionId: preferred.id, role: 'PREFERRED' as const, objections: (data.objections || []).map((o: any, i: number) => ({ id: o.id || `obj_${i}`, argument: o.argument || '', hiddenAssumption: o.hiddenAssumption || '', failureMode: o.failureMode || '', whatMustBeTrueForCritiqueToBeWeak: o.whatMustBeTrueForCritiqueToBeWeak || '', verifiability: o.verifiability || 'SPECULATION' })), meta };
            update({ preferredOptionId: preferred.id, redTeam: [...d.redTeam.filter((r) => r.role !== 'PREFERRED'), round] });
            runApi('/api/redteam', { brief: d.brief, option: opposite, role: 'OPPOSITE', radar: d.radar, knowledgeMap: d.knowledgeMap }, (data2, meta2) => {
              const round2 = { targetOptionId: opposite.id, role: 'OPPOSITE' as const, objections: (data2.objections || []).map((o: any, i: number) => ({ id: o.id || `obj2_${i}`, argument: o.argument || '', hiddenAssumption: o.hiddenAssumption || '', failureMode: o.failureMode || '', whatMustBeTrueForCritiqueToBeWeak: o.whatMustBeTrueForCritiqueToBeWeak || '', verifiability: o.verifiability || 'SPECULATION' })), meta: meta2 };
              update({ oppositeOptionId: opposite.id, redTeam: [...d.redTeam.filter((r) => r.role !== 'OPPOSITE'), round2] });
            });
          });
        }}>Проверить риски</button>
      </div>
      {d.redTeam.map((r) => (
        <div key={r.role} className="panel" style={{ marginTop: 12 }}>
          <h3>
            Objections · {r.role === 'PREFERRED' ? 'preferred' : 'opposite'}
          </h3>
          {r.objections.map((o) => (
            <div key={o.id} className="question">
              <b>{o.argument}</b>
              <small>
                Hidden assumption: {o.hiddenAssumption}. Failure mode: {o.failureMode}. [
                {o.verifiability}]
              </small>
              <div className="question-actions">
                <button
                  className={o.response?.verdict === 'ACCEPTED' ? 'selected' : ''}
                  onClick={() =>
                    update({
                      redTeam: d.redTeam.map((rr) =>
                        rr.role !== r.role
                          ? rr
                          : {
                              ...rr,
                              objections: rr.objections.map((oo) =>
                                oo.id === o.id
                                  ? {
                                      ...oo,
                                      response: {
                                        verdict: 'ACCEPTED',
                                        reason: oo.response?.reason || '',
                                      },
                                    }
                                  : oo
                              ),
                            }
                      ),
                    })
                  }
                >
                  Accepted
                </button>
                <button
                  className={o.response?.verdict === 'REJECTED' ? 'selected' : ''}
                  onClick={() =>
                    update({
                      redTeam: d.redTeam.map((rr) =>
                        rr.role !== r.role
                          ? rr
                          : {
                              ...rr,
                              objections: rr.objections.map((oo) =>
                                oo.id === o.id
                                  ? {
                                      ...oo,
                                      response: {
                                        verdict: 'REJECTED',
                                        reason: oo.response?.reason || '',
                                      },
                                    }
                                  : oo
                              ),
                            }
                      ),
                    })
                  }
                >
                  Rejected
                </button>
              </div>
              <input
                placeholder="Reason (required)"
                value={o.response?.reason || ''}
                onChange={(e) =>
                  update({
                    redTeam: d.redTeam.map((rr) =>
                      rr.role !== r.role
                        ? rr
                        : {
                            ...rr,
                            objections: rr.objections.map((oo) =>
                              oo.id === o.id
                                ? {
                                    ...oo,
                                    response: {
                                      // Do not silently default to ACCEPTED without an explicit verdict
                                      verdict: oo.response?.verdict || 'REJECTED',
                                      reason: e.target.value,
                                    },
                                  }
                                : oo
                            ),
                          }
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      ))}

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Pre-mortem</h2>
        <button
          className="primary"
          disabled={busy || !allAnswered}
          onClick={() =>
            runApi(
              '/api/premortem',
              {
                brief: d.brief,
                preferredOption: preferred,
                redTeamRounds: d.redTeam,
                radar: d.radar,
                knowledgeMap: d.knowledgeMap,
                answeredUnknowns: (d.radar?.unknowns || [])
                  .filter((u) => u.critical)
                  .map((u) => ({
                    question: u.question || u.text,
                    answer: u.answer,
                    status: u.status,
                    owner: u.owner,
                  })),
              },
              (data, meta) => {
                const cands: Hypothesis[] = (data.hypothesisCandidates || []).map(
                  (h: any, i: number) => ({
                    id: h.id || uid('hyp'),
                    text: h.text || '',
                    verifiability: h.verifiability || 'SPECULATION',
                    selectedByUser: false,
                  })
                );
                update({
                  preMortem: {
                    horizonMonths: data.horizonMonths || 18,
                    causes: data.causes || [],
                    narrative: data.narrative || '',
                    whatDistinguishesFromForecast:
                      data.whatDistinguishesFromForecast || '',
                    meta,
                  },
                  hypotheses: cands,
                });
              }
            )
          }
        >
          Pre-mortem
        </button>
        {d.preMortem && (
          <div style={{ marginTop: 12 }}>
            <p>
              <em>{en.scenarioNotForecast}</em>
            </p>
            <p>{d.preMortem.narrative}</p>
            <small>{d.preMortem.whatDistinguishesFromForecast}</small>
            <h4>Reasons</h4>
            <ul>
              {d.preMortem.causes.map((c, i) => (
                <li key={i}>
                  {c.text} [{c.verifiability}]
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Critical hypotheses (1–3)</h2>
        {d.hypotheses.map((h) => {
          const isSpec = h.verifiability === 'SPECULATION' && !h.rewrittenByUser?.trim();
          const needsText = !h.text.trim();
          return (
            <div key={h.id} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={!!h.selectedByUser}
                disabled={
                  (!h.selectedByUser && selectedHyps.length >= 3) ||
                  needsText ||
                  isSpec
                }
                onChange={(e) => {
                  if (isSpec) {
                    alert('Rewrite speculative hypothesis into a testable statement');
                    return;
                  }
                  if (needsText) {
                    alert('Enter hypothesis text first');
                    return;
                  }
                  update({
                    hypotheses: d.hypotheses.map((x) =>
                      x.id === h.id ? { ...x, selectedByUser: e.target.checked } : x
                    ),
                  });
                }}
              />
              <div style={{ flex: 1 }}>
                {h.text.trim() && !isSpec && !needsText ? (
                  <span>
                    {h.text} [{h.verifiability}]
                  </span>
                ) : null}
                {(isSpec || needsText) && (
                  <input
                    placeholder={
                      isSpec
                        ? 'Rewrite into a testable statement'
                        : 'Your hypothesis text'
                    }
                    value={isSpec ? h.rewrittenByUser || '' : h.text}
                    onChange={(e) => {
                      const v = e.target.value;
                      update({
                        hypotheses: d.hypotheses.map((x) =>
                          x.id === h.id
                            ? isSpec
                              ? {
                                  ...x,
                                  rewrittenByUser: v,
                                  text: v || x.text,
                                }
                              : { ...x, text: v, verifiability: 'TESTABLE' as const }
                            : x
                        ),
                      });
                    }}
                    style={{ display: 'block', marginTop: 4, width: '100%' }}
                  />
                )}
                {isSpec && (h.rewrittenByUser || '').trim() && (
                  <button
                    className="ghost"
                    style={{ marginTop: 4 }}
                    onClick={() =>
                      update({
                        hypotheses: d.hypotheses.map((x) =>
                          x.id === h.id
                            ? {
                                ...x,
                                text: (x.rewrittenByUser || '').trim(),
                                verifiability: 'TESTABLE',
                                rewrittenByUser: (x.rewrittenByUser || '').trim(),
                              }
                            : x
                        ),
                      })
                    }
                  >
                    Confirm rewrite
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          className="ghost"
          onClick={() =>
            update({
              hypotheses: [
                ...d.hypotheses,
                {
                  id: uid('hyp'),
                  text: '',
                  verifiability: 'TESTABLE',
                  selectedByUser: false,
                },
              ],
            })
          }
        >
          <Plus size={14} /> Own hypothesis
        </button>
        <div className="actions" style={{ marginTop: 16 }}>
          <button
            className="primary"
            disabled={
              selectedHyps.length < 1 ||
              selectedHyps.length > 3 ||
              selectedHyps.some(
                (h) =>
                  !h.text.trim() ||
                  (h.verifiability === 'SPECULATION' && !h.rewrittenByUser?.trim())
              )
            }
            onClick={() => update({ step: 'TEST' })}
          >
            {en.continue} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// --- TEST ---
function TestScreen({
  d,
  update,
  runApi,
  busy,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  busy: boolean;
}) {
  const selected = d.hypotheses.filter((h) => h.selectedByUser);
  // Contour 4: each selected hypothesis needs a locked card with metric, deadline, thresholds, forecast
  const allHypsCovered = selected.every((h) => {
    const card = d.experiments.find(
      (e) => e.hypothesisId === h.id && (e.status === 'READY' || e.lockedAt)
    );
    return (
      !!card &&
      !!card.metric?.trim() &&
      !!(card.deadline || (card as any).deadlineWords)?.toString().trim() &&
      !!card.successThreshold?.trim() &&
      !!card.stopThreshold?.trim() &&
      !!card.forecast?.wording?.trim() &&
      card.forecast?.confidence !== undefined
    );
  });
  const finalCostSet = !!d.brief.errorCost?.final;
  const finalRevSet = !!d.brief.reversibility?.final;

  return (
    <div>
      <div className="panel">
        <h2>Experiment drafts</h2>
        <p style={{ fontSize: 12, color: '#7f93aa' }}>
          Each selected hypothesis needs a locked card (metric, deadline, thresholds,
          forecast). Re-fetching drafts does not overwrite locked cards.
        </p>
        <button
          className="primary"
          disabled={busy || selected.length < 1}
          onClick={() =>
            runApi(
              '/api/experiment-draft',
              {
                brief: d.brief,
                hypotheses: selected,
                // Pass context from contour 1 so each loop feeds the next
                radar: d.radar,
                knowledgeMap: d.knowledgeMap,
                answeredUnknowns: (d.radar?.unknowns || [])
                  .filter((u) => u.critical && (u.answer || u.status))
                  .map((u) => ({
                    question: u.question || u.text,
                    answer: u.answer,
                    status: u.status,
                    owner: u.owner,
                  })),
              },
              (data) => {
                const locked = d.experiments.filter(
                  (e) => e.status === 'READY' || e.lockedAt || e.status === 'RUNNING' || e.status === 'COMPLETED'
                );
                const lockedHypIds = new Set(locked.map((e) => e.hypothesisId));
                const drafts: ExperimentCard[] = (data.drafts || [])
                  .filter((dr: any) => {
                    const hid = dr.hypothesisId || selected[0]?.id || '';
                    return !lockedHypIds.has(hid);
                  })
                  .map((dr: any) => ({
                    id: uid('exp'),
                    hypothesisId: dr.hypothesisId || selected[0]?.id || '',
                    whyCritical: dr.whyCritical || '',
                    test: dr.test || '',
                    metric: dr.metric || '',
                    deadlineWords: dr.deadlineWords || '',
                    thresholdQuestions: dr.threshold_questions || [],
                    validityThreats: (dr.validity_threats || []).map((t: any) => ({
                      threat: t.threat || '',
                      protection: t.protection || '',
                      handled: false,
                    })),
                    ifSuccess: dr.ifSuccessHint || '',
                    ifFailure: dr.ifFailureHint || '',
                    status: 'DRAFT' as const,
                    evidenceIds: [],
                    history: [],
                    thresholdShiftedAfterStart: false,
                  }));
                // Keep locked cards; replace only drafts for unlocked hypotheses
                const kept = d.experiments.filter(
                  (e) =>
                    e.status === 'READY' ||
                    e.lockedAt ||
                    e.status === 'RUNNING' ||
                    e.status === 'COMPLETED' ||
                    !selected.some((h) => h.id === e.hypothesisId)
                );
                update({ experiments: [...kept, ...drafts] });
              }
            )
          }
        >
          Get drafts
        </button>
      </div>

      {d.experiments.map((exp) => (
        <ExperimentCardEditor
          key={exp.id}
          exp={exp}
          d={d}
          update={update}
          busy={busy}
          runApi={runApi}
        />
      ))}

      <div className="panel" style={{ marginTop: 12 }}>
        <h3>Final cost of error and reversibility (before locking kill criteria)</h3>
        <p style={{ fontSize: 12, color: '#7f93aa' }}>
          The method requires a final assessment before locking kill criteria.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <label>Cost of error (final)</label>
            <select
              value={d.brief.errorCost.final || ''}
              onChange={(e) =>
                update({
                  brief: {
                    ...d.brief,
                    errorCost: {
                      ...d.brief.errorCost,
                      final: (e.target.value || undefined) as Level | undefined,
                    },
                  },
                })
              }
            >
              <option value="">—</option>
              <option value="LOW">low</option>
              <option value="MEDIUM">medium</option>
              <option value="HIGH">high</option>
              <option value="UNKNOWN">unknown</option>
            </select>
          </div>
          <div>
            <label>Reversibility (final)</label>
            <select
              value={d.brief.reversibility.final || ''}
              onChange={(e) =>
                update({
                  brief: {
                    ...d.brief,
                    reversibility: {
                      ...d.brief.reversibility,
                      final: (e.target.value || undefined) as Door | 'UNKNOWN' | undefined,
                    },
                  },
                })
              }
            >
              <option value="">—</option>
              <option value="TWO_WAY">two-way door (can reverse)</option>
              <option value="ONE_WAY">one-way door (costly to reverse)</option>
              <option value="UNKNOWN">unknown</option>
            </select>
          </div>
        </div>
        {d.brief.errorCost.final === 'HIGH' && d.brief.reversibility.final === 'ONE_WAY' && (
          <div className="alert" style={{ marginTop: 8 }}>
            High cost of error and hard-to-reverse step: independent re-run is recommended
            (new chat / different model) plus human expert review. Section 11.
          </div>
        )}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="primary"
          disabled={!allHypsCovered || !finalCostSet || !finalRevSet}
          title={
            !allHypsCovered
              ? 'Lock a card with metric, deadline, thresholds, and forecast for each hypothesis'
              : !finalCostSet || !finalRevSet
                ? 'Set final cost of error and reversibility'
                : undefined
          }
          onClick={() => {
            // Only set review dates once if empty; do not recalculate on every continue
            const dates =
              d.brief.reviewDates?.length === 3
                ? d.brief.reviewDates
                : computeReviewDates(new Date());
            update({
              brief: { ...d.brief, reviewDates: dates },
              step: 'DECIDE',
            });
          }}
        >
          {en.continue} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

function ExperimentCardEditor({
  exp,
  d,
  update,
  busy,
  runApi,
}: {
  exp: ExperimentCard;
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  busy: boolean;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
}) {
  const locked = !!exp.lockedAt;
  const patch = (p: Partial<ExperimentCard>) => {
    if (locked && !['result', 'resultValue', 'status', 'completedAt', 'startedAt'].some((k) => k in p)) {
      return;
    }
    update({
      experiments: d.experiments.map((e) => (e.id === exp.id ? { ...e, ...p } : e)),
    });
  };

  // EVPI local state
  const [p, setP] = useState(40);
  const [G, setG] = useState(100);
  const [L, setL] = useState(150);
  const [c, setC] = useState(10);
  const pNorm = p > 1 ? p / 100 : p;
  const err = validateEvpiInput(pNorm, G, L, c);
  const result = !err ? evpi(pNorm, G, L) : null;
  const range = !err ? evpiRange(pNorm, G, L) : null;
  const verdict = range ? evpiVerdict(c, range) : null;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3>
        <FlaskConical size={16} /> Experiment {locked && <Lock size={14} />}
        {exp.thresholdShiftedAfterStart && ' · threshold shifted'}
      </h3>
      <div className="formgrid">
        <Field label="Why critical" value={exp.whyCritical} onChange={(v) => patch({ whyCritical: v })} />
        <Field label="Test" value={exp.test} onChange={(v) => patch({ test: v })} />
        <Field label="Metric" value={exp.metric} onChange={(v) => patch({ metric: v })} />
        <Field label="Deadline (date)" value={exp.deadline || ''} onChange={(v) => patch({ deadline: v })} />
        <Field
          label="Success threshold"
          value={exp.successThreshold || ''}
          onChange={(v) => patch({ successThreshold: v })}
        />
        <Field
          label="Stop threshold"
          value={exp.stopThreshold || ''}
          onChange={(v) => patch({ stopThreshold: v })}
        />
        <Field
          label="Intermediate outcome"
          value={exp.intermediateOutcome || ''}
          onChange={(v) => patch({ intermediateOutcome: v })}
        />
        <Field label="If success" value={exp.ifSuccess || ''} onChange={(v) => patch({ ifSuccess: v })} />
        <Field label="If failure" value={exp.ifFailure || ''} onChange={(v) => patch({ ifFailure: v })} />
        <Field
          label="What to do if stopped"
          value={exp.whatToDoAfterStop || ''}
          onChange={(v) => patch({ whatToDoAfterStop: v })}
        />
        <Field
          label="What result would make you change your mind? *"
          value={exp.whatWouldChangeMyMind || ''}
          onChange={(v) => patch({ whatWouldChangeMyMind: v })}
        />
      </div>
      {exp.thresholdQuestions?.length > 0 && (
        <div className="alert" style={{ marginTop: 8 }}>
          Model questions about thresholds (answer with your own numbers above):
          <ul>
            {exp.thresholdQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {exp.validityThreats?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h4>Validity threats</h4>
          {exp.validityThreats.map((t, i) => (
            <label key={i} style={{ display: 'flex', gap: 8 }}>
              <input
                type="checkbox"
                checked={t.handled}
                onChange={(e) => {
                  const validityThreats = exp.validityThreats.map((x, j) =>
                    j === i ? { ...x, handled: e.target.checked } : x
                  );
                  patch({ validityThreats });
                }}
              />
              {t.threat} — mitigation: {t.protection}
            </label>
          ))}
        </div>
      )}

      {/* Forecast (user only) */}
      <div className="forecast" style={{ marginTop: 12 }}>
        <h4>Forecast (human only)</h4>
        {!locked && (
          <button
            className="ghost"
            style={{ marginBottom: 8 }}
            disabled={busy}
            onClick={() =>
              runApi('/api/forecast-wording', { experiment: exp }, (data) => {
                if (data?.wording || data?.suggestedWording) {
                  patch({
                    forecast: {
                      wording: data.wording || data.suggestedWording || exp.forecast?.wording || '',
                      confidence: exp.forecast?.confidence,
                      rationale: exp.forecast?.rationale,
                      source: 'USER',
                    },
                  });
                }
              })
            }
          >
            Help phrase it (model does not set confidence)
          </button>
        )}
        <textarea
          placeholder="Forecast wording"
          value={exp.forecast?.wording || ''}
          disabled={locked}
          onChange={(e) =>
            patch({
              forecast: {
                wording: e.target.value,
                confidence: exp.forecast?.confidence,
                rationale: exp.forecast?.rationale,
                source: 'USER',
              },
            })
          }
          rows={2}
          style={{ width: '100%' }}
        />
        <label style={{ display: 'block', marginTop: 6 }}>
          Basis
          <textarea
            placeholder="What data/assumptions the forecast rests on"
            value={exp.forecast?.rationale || ''}
            disabled={locked}
            onChange={(e) =>
              patch({
                forecast: {
                  wording: exp.forecast?.wording || '',
                  confidence: exp.forecast?.confidence,
                  rationale: e.target.value,
                  source: 'USER',
                },
              })
            }
            rows={2}
            style={{ width: '100%' }}
          />
        </label>
        <div className="forecast-inputs">
          <label>
            Confidence % or “low”
            <input
              disabled={locked}
              value={
                exp.forecast?.confidence === 'LOW_NO_DATA'
                  ? 'low'
                  : exp.forecast?.confidence ?? ''
              }
              onChange={(e) => {
                const v = e.target.value.trim();
                let confidence: number | 'LOW_NO_DATA' | undefined;
                if (v === '') confidence = undefined;
                else if (/low|insuffic/i.test(v)) confidence = 'LOW_NO_DATA';
                else {
                  const n = Number(v.replace('%', ''));
                  if (!Number.isFinite(n)) return;
                  confidence = Math.max(0, Math.min(100, n));
                }
                patch({
                  forecast: {
                    wording: exp.forecast?.wording || '',
                    confidence,
                    rationale: exp.forecast?.rationale,
                    source: 'USER',
                  },
                });
              }}
            />
          </label>
        </div>
      </div>

      {/* EVPI */}
      <div style={{ marginTop: 12, borderTop: '1px solid #1c3044', paddingTop: 12 }}>
        <h4>EVPI (local calculation)</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label>
            p %
            <input type="number" value={p} onChange={(e) => setP(Number(e.target.value))} />
          </label>
          <label>
            G
            <input type="number" value={G} onChange={(e) => setG(Number(e.target.value))} />
          </label>
          <label>
            L
            <input type="number" value={L} onChange={(e) => setL(Number(e.target.value))} />
          </label>
          <label>
            c
            <input type="number" value={c} onChange={(e) => setC(Number(e.target.value))} />
          </label>
          <button
            className="ghost"
            onClick={() => {
              setP(40);
              setG(100);
              setL(150);
              setC(10);
            }}
          >
            Example from the article
          </button>
        </div>
        {result && range && verdict && (
          <div className="alert" style={{ marginTop: 8 }}>
            Expectation without information: {result.evOpen.toFixed(1)}; EVPI = {result.evpi.toFixed(1)};
            range {range.min.toFixed(0)}–{range.max.toFixed(0)}. {verdict.text}
            <br />
            <small>
              Rough estimates; risk-neutral assumption; real tests yield incomplete information.
            </small>
            {!locked && (
              <button
                className="ghost"
                style={{ marginTop: 6 }}
                onClick={() =>
                  patch({
                    evpi: { p: pNorm, gain: G, loss: L, testCost: c, unit: 'USD' },
                  })
                }
              >
                Save EVPI to card
              </button>
            )}
          </div>
        )}
        {err && <div className="alert error">{err}</div>}
      </div>

      {/* Final cost / reversibility */}
      <div style={{ marginTop: 12 }}>
        <label>Final cost of error</label>
        <select
          value={d.brief.errorCost.final || ''}
          onChange={(e) =>
            update({
              brief: {
                ...d.brief,
                errorCost: {
                  ...d.brief.errorCost,
                  final: (e.target.value || undefined) as Level | undefined,
                },
              },
            })
          }
        >
          <option value="">—</option>
          <option value="LOW">low</option>
          <option value="MEDIUM">medium</option>
          <option value="HIGH">high</option>
          <option value="UNKNOWN">unknown</option>
        </select>
        <label style={{ marginLeft: 12 }}>Final reversibility</label>
        <select
          value={d.brief.reversibility.final || ''}
          onChange={(e) =>
            update({
              brief: {
                ...d.brief,
                reversibility: {
                  ...d.brief.reversibility,
                  final: (e.target.value || undefined) as Door | 'UNKNOWN' | undefined,
                },
              },
            })
          }
        >
          <option value="">—</option>
          <option value="TWO_WAY">two-way (can reverse)</option>
          <option value="ONE_WAY">one-way (costly to reverse)</option>
          <option value="UNKNOWN">unknown</option>
        </select>
      </div>

      {!locked ? (
        <button
          className="primary"
          style={{ marginTop: 12 }}
          disabled={
            !exp.metric ||
            !exp.deadline ||
            !exp.successThreshold ||
            !exp.stopThreshold ||
            !exp.intermediateOutcome ||
            !exp.ifSuccess ||
            !exp.ifFailure ||
            !exp.whatToDoAfterStop ||
            !exp.whatWouldChangeMyMind ||
            !exp.forecast?.wording
          }
          onClick={() => {
            if (!exp.whatWouldChangeMyMind?.trim()) {
              if (!confirm('Empty “what would change your mind” — the test may not be needed. Continue?'))
                return;
            }
            const conf = exp.forecast?.confidence;
            if (conf === undefined || conf === null || conf === ('' as any)) {
              alert('Before locking, set confidence (0–100 or “low”). The method requires a forecast with confidence before the test.');
              return;
            }
            if (!exp.forecast?.wording?.trim()) {
              alert('Before locking, fill in the forecast wording.');
              return;
            }
            const lockedAt = Date.now();
            // One journal entry per forecast (not three independent Brier rows with the same wording)
            const hyp =
              d.hypotheses.find((h) => h.id === exp.hypothesisId)?.text ||
              exp.whyCritical ||
              exp.hypothesisId ||
              '';
            const dates = d.brief.reviewDates?.length
              ? d.brief.reviewDates
              : computeReviewDates();
            const entry: JournalEntry = {
              id: uid('j'),
              createdAt: lockedAt,
              hypothesis: hyp,
              forecastWording: exp.forecast?.wording || '',
              confidence: exp.forecast?.confidence,
              rationale: exp.forecast?.rationale || '',
              reviewDate: dates[0],
              horizonDays: 30,
              noResultYet: true,
            };
            update({
              experiments: d.experiments.map((e) =>
                e.id === exp.id
                  ? {
                      ...e,
                      status: 'READY' as const,
                      lockedAt,
                      // Persist EVPI if user computed it
                      evpi: e.evpi,
                    }
                  : e
              ),
              journal: [...d.journal, entry],
            });
          }}
        >
          <Lock size={14} /> {en.lockCard}
        </button>
      ) : (
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="ghost"
            onClick={() => patch({ status: 'RUNNING', startedAt: Date.now() })}
          >
            {en.startTest}
          </button>
          <button
            className="ghost"
            onClick={async () => {
              const hash = await cardChecksum(exp);
              const text = `Experiment Card\n${JSON.stringify(exp, null, 2)}\n\nSHA-256: ${hash}\n(Hash shows the copy was not altered)`;
              downloadBlob(new Blob([text], { type: 'text/plain' }), `exp_${exp.id}.txt`);
            }}
          >
            Copy for a third party
          </button>
          <button
            className="ghost"
            onClick={() => {
              const reason = prompt('Reason for shifting the threshold (required)');
              if (!reason) return;
              const neu = prompt('New stop threshold', exp.stopThreshold);
              if (neu == null) return;
              patch({
                stopThreshold: neu,
                thresholdShiftedAfterStart: true,
                history: [
                  ...exp.history,
                  {
                    at: Date.now(),
                    field: 'stopThreshold',
                    from: exp.stopThreshold || '',
                    to: neu,
                    reason,
                  },
                ],
              });
            }}
          >
            Shift threshold
          </button>
        </div>
      )}
    </div>
  );
}

// --- DECIDE ---
function DecideScreen({
  d,
  update,
  runApi,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
}) {
  const hd = d.decision;
  const setHd = (patch: Partial<HumanDecision>) => {
    const base: HumanDecision = hd || {
      kind: 'CHOOSE_OPTION',
      whatIDecided: '',
      onWhichValues: '',
      underWhichData: '',
      acceptedUncertainties: [],
      decidedAt: Date.now(),
    };
    update({ decision: { ...base, ...patch, decidedAt: base.decidedAt || Date.now() } });
  };

  return (
    <div className="panel">
      <h2>Что вы решили — решаете вы</h2>
      <p style={{ fontSize: 12, color: '#7f93aa' }}>
        Я не выбираю вариант за вас. Здесь вы фиксируете собственное решение — или решение пока отложить.
      </p>
      <div className="formgrid">
        <div>
          <label>Type</label>
          <select
            value={hd?.kind || 'CHOOSE_OPTION'}
            onChange={(e) => setHd({ kind: e.target.value as HumanDecision['kind'] })}
          >
            <option value="CHOOSE_OPTION">Choose option</option>
            <option value="POSTPONE">Postpone</option>
            <option value="RUN_TESTS">Run tests first</option>
            <option value="REFUSE">Refuse</option>
          </select>
        </div>
        {hd?.kind === 'CHOOSE_OPTION' && (
          <div>
            <label>Option</label>
            <select
              value={hd?.chosenOptionId || ''}
              onChange={(e) => setHd({ chosenOptionId: e.target.value })}
            >
              <option value="">—</option>
              {d.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <Field
          label="What I decided"
          value={hd?.whatIDecided || ''}
          onChange={(v) => setHd({ whatIDecided: v })}
        />
        <Field
          label="Based on which values"
          value={hd?.onWhichValues || ''}
          onChange={(v) => setHd({ onWhichValues: v })}
        />
        <Field
          label="Based on which data"
          value={hd?.underWhichData || ''}
          onChange={(v) => setHd({ underWhichData: v })}
        />
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="primary"
          disabled={!hd?.whatIDecided?.trim()}
          onClick={() => {
            const dates =
              d.brief.reviewDates?.length > 0
                ? d.brief.reviewDates
                : computeReviewDates(new Date());
            update({
              brief: { ...d.brief, reviewDates: dates },
              step: 'SYNTHESIS',
            });
          }}
        >
          {en.continue} <ArrowRight size={16} />
        </button>
      </div>
      {d.brief.reviewDates?.length > 0 && (
        <div className="alert" style={{ marginTop: 12 }}>
          Review: {d.brief.reviewDates.join(' · ')}
        </div>
      )}
    </div>
  );
}

// --- SYNTHESIS ---
function SynthesisScreen({
  d,
  update,
  runApi,
  busy,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  busy: boolean;
}) {
  return (
    <div className="panel">
      <h2>Карта решения</h2>
      <button
        className="primary"
        disabled={busy}
        onClick={() =>
          runApi(
            '/api/synthesis',
            {
              brief: d.brief,
              options: d.options,
              hypotheses: d.hypotheses.filter((h) => h.selectedByUser),
              experiments: d.experiments,
              decision: d.decision,
              radar: d.radar,
              knowledgeMap: d.knowledgeMap,
              preMortem: d.preMortem,
            },
            (data, meta) => {
              update({
                synthesis: {
                  paragraphs: data.paragraphs || ['', '', '', ''],
                  derivedNumbers: data.derived_numbers || [],
                  openGaps: data.open_gaps || [],
                  needsExternalCheck: data.needs_external_check || [],
                  unverifiedNumbers: [],
                  meta,
                },
              });
            }
          )
        }
      >
        Собрать текущую картину
      </button>
      {d.synthesis && (
        <div style={{ marginTop: 16 }}>
          {d.synthesis.paragraphs.map((p, i) => (
            <p key={i} style={{ lineHeight: 1.6 }}>
              {p}
            </p>
          ))}
          {d.synthesis.openGaps?.length > 0 && (
            <div className="alert">
              Gaps: {d.synthesis.openGaps.join('; ')}
            </div>
          )}
          {d.synthesis.needsExternalCheck?.length > 0 && (
            <div className="alert">
              External check: {d.synthesis.needsExternalCheck.join('; ')}
            </div>
          )}
          <textarea
            placeholder="Ваши заметки (необязательно)"
            value={d.synthesis.editedByUser || ''}
            onChange={(e) =>
              update({
                synthesis: { ...d.synthesis!, editedByUser: e.target.value },
              })
            }
            rows={4}
            style={{ width: '100%', marginTop: 12 }}
          />
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="ghost"
              onClick={() => {
                const text = [
                  ...d.synthesis!.paragraphs,
                  '',
                  `${en.myDecision}: ${d.decision?.whatIDecided || ''}`,
                ].join('\n\n');
                navigator.clipboard?.writeText(text);
                alert('Copied to clipboard');
              }}
            >
              Copy
            </button>
            <button className="primary" onClick={() => update({ step: 'LEARN' })}>
              {en.continue} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- LEARN ---
function LearnScreen({
  d,
  update,
  runApi,
  onNextCycle,
}: {
  d: Decision;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
  runApi: (path: string, body: unknown, onOk: (data: any, meta: any) => void) => void;
  onNextCycle: () => void;
}) {
  const addEntry = () => {
    const entry: JournalEntry = {
      id: uid('j'),
      createdAt: Date.now(),
      hypothesis: '',
      forecastWording: '',
      reviewDate: d.brief.reviewDates?.[0] || computeReviewDates()[0],
      horizonDays: 30,
    };
    update({ journal: [...d.journal, entry] });
  };

  const brierEntries = d.journal
    .filter(
      (j) =>
        typeof j.confidence === 'number' &&
        typeof j.outcome === 'boolean' &&
        j.confidence !== undefined
    )
    .map((j) => ({
      confidence: (j.confidence as number) > 1 ? (j.confidence as number) / 100 : (j.confidence as number),
      outcome: j.outcome!,
    }));
  const brier = brierEntries.length ? brierScore(brierEntries) : null;

  return (
    <div className="panel">
      <h2>Journal and learning</h2>
      <button className="ghost" onClick={addEntry}>
        <Plus size={14} /> Journal entry
      </button>
      {d.journal.map((j) => (
        <div key={j.id} className="question" style={{ marginTop: 10 }}>
          <input
            placeholder="Hypothesis"
            value={j.hypothesis}
            disabled={!!j.fact || !!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, hypothesis: e.target.value } : x
                ),
              })
            }
          />
          <input
            placeholder="Forecast (wording)"
            value={j.forecastWording}
            disabled={!!j.fact || !!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, forecastWording: e.target.value } : x
                ),
              })
            }
          />
          <input
            placeholder="Confidence 0–100 or “low”"
            value={
              j.confidence === 'LOW_NO_DATA' ? 'low' : j.confidence ?? ''
            }
            disabled={!!j.fact || !!j.reviewedAt}
            onChange={(e) => {
              const v = e.target.value.trim();
              let confidence: number | 'LOW_NO_DATA' | undefined;
              if (v === '') confidence = undefined;
              else if (/low/i.test(v)) confidence = 'LOW_NO_DATA';
              else {
                const n = Number(v.replace('%', ''));
                if (!Number.isFinite(n)) return;
                // store as 0–100; Brier normalizes later
                confidence = Math.max(0, Math.min(100, n));
              }
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, confidence } : x
                ),
              });
            }}
          />
          <input
            placeholder="Basis"
            value={j.rationale || ''}
            disabled={!!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, rationale: e.target.value } : x
                ),
              })
            }
          />
          <input
            placeholder="Fact / result"
            value={j.fact || ''}
            disabled={!!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, fact: e.target.value, noResultYet: false } : x
                ),
              })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={!!j.noResultYet}
              disabled={!!j.reviewedAt}
              onChange={(e) =>
                update({
                  journal: d.journal.map((x) =>
                    x.id === j.id
                      ? {
                          ...x,
                          noResultYet: e.target.checked,
                          // Clearing «result not yet» does not unlock fact after review
                          ...(e.target.checked ? { fact: undefined, outcome: undefined } : {}),
                        }
                      : x
                  ),
                })
              }
            />{' '}
            Result not yet
          </label>
          <label>
            Occurred:{' '}
            <select
              value={j.outcome === true ? 'yes' : j.outcome === false ? 'no' : ''}
              disabled={!!j.reviewedAt || !!j.noResultYet}
              onChange={(e) =>
                update({
                  journal: d.journal.map((x) =>
                    x.id === j.id
                      ? {
                          ...x,
                          outcome:
                            e.target.value === 'yes'
                              ? true
                              : e.target.value === 'no'
                                ? false
                                : undefined,
                        }
                      : x
                  ),
                })
              }
            >
              <option value="">—</option>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </label>
          <select
            value={j.errorType || ''}
            disabled={!!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id
                    ? {
                        ...x,
                        errorType: (e.target.value || undefined) as JournalEntry['errorType'],
                      }
                    : x
                ),
              })
            }
          >
            <option value="">Discrepancy type</option>
            <option value="DATA">Data</option>
            <option value="ASSUMPTION">Assumption</option>
            <option value="REASONING">Reasoning</option>
            <option value="EXECUTION">Execution</option>
            <option value="LUCK">Chance</option>
          </select>
          <input
            placeholder="What I updated"
            value={j.whatIUpdated || ''}
            disabled={!!j.reviewedAt}
            onChange={(e) =>
              update({
                journal: d.journal.map((x) =>
                  x.id === j.id ? { ...x, whatIUpdated: e.target.value } : x
                ),
              })
            }
          />
          {!j.reviewedAt && j.fact && j.outcome !== undefined && (
            <button
              className="ghost"
              onClick={() => {
                runApi(
                  '/api/review',
                  { entry: j },
                  (data) => {
                    update({
                      journal: d.journal.map((x) =>
                        x.id === j.id
                          ? {
                              ...x,
                              reviewedAt: Date.now(),
                              diagnosisNote: data?.note || data?.questions?.join('; ') || x.diagnosisNote,
                              discrepancy: data?.discrepancy || x.discrepancy,
                              // Lock fact after review — clearing the field no longer reopens
                            }
                          : x
                      ),
                    });
                  }
                );
              }}
            >
              Review discrepancy (model)
            </button>
          )}
          {!j.reviewedAt && j.fact && j.outcome !== undefined && (
            <button
              className="primary"
              onClick={() =>
                update({
                  journal: d.journal.map((x) =>
                    x.id === j.id ? { ...x, reviewedAt: Date.now() } : x
                  ),
                })
              }
            >
              Lock review
            </button>
          )}
          {j.reviewedAt && (
            <small style={{ color: '#7f93aa' }}>
              Review locked · fact cannot be erased to bypass the lock
            </small>
          )}
        </div>
      ))}
      {brier && (
        <div className="alert" style={{ marginTop: 12 }}>
          Brier ≈ {brier.score.toFixed(2)} (N={brier.n}, baseline 0.25)
          {brier.warning && ` · ${brier.warning}`}
        </div>
      )}
      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="ghost"
          onClick={() => {
            const events = (d.brief.reviewDates || []).map((date, i) => ({
              uid: `${d.id}-rev-${i}@bifurcation`,
              date,
              summary: 'Decision review',
            }));
            const ics = buildIcs(events);
            downloadBlob(new Blob([ics], { type: 'text/calendar' }), 'review.ics');
          }}
        >
          Download .ics
        </button>
        <button className="primary" onClick={onNextCycle}>
          {en.nextCycle}
        </button>
      </div>
    </div>
  );
}

// --- Brief side panel ---
function BriefPanel({
  d,
  onClose,
  update,
}: {
  d: Decision;
  onClose: () => void;
  update: (p: Partial<Decision> | ((x: Decision) => Decision)) => void;
}) {
  return (
    <div className="privacy" style={{ maxHeight: '80vh', overflow: 'auto' }}>
      <h2>Decision Brief</h2>
      <button className="ghost" onClick={onClose}>
        Close
      </button>
      <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(d.brief, null, 2)}
      </pre>
      {d.brief.reviewDates?.length > 0 && (
        <p>Review: {d.brief.reviewDates.join(' · ')}</p>
      )}
    </div>
  );
}
