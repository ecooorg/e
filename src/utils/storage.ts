/** localStorage v11 with legacy archive */

import {
  Decision,
  emptyDecision,
  SCHEMA_VERSION,
  Step,
} from '../types/decision';

const KEY = 'bifurcation_decisions_v11';
const ACTIVE = 'bifurcation_active_id_v11';
const PRIVACY = 'bifurcation_privacy_v11';
const ARCHIVE = 'bifurcation_archive_v11';
const MIGRATION_REPORT = 'bifurcation_migration_report_v11';

const VALID_STEPS: Step[] = [
  'TRIAGE',
  'BRIEF',
  'UNDERSTAND',
  'EXPAND',
  'ATTACK',
  'TEST',
  'DECIDE',
  'SYNTHESIS',
  'LEARN',
];

function mapOldStep(x: any): Step {
  if (VALID_STEPS.includes(x.step)) return x.step;
  if (VALID_STEPS.includes(x.stage)) return x.stage;
  if (x.phase === 'ANALYSIS' || x.phase === 'VERIFY') return 'TEST';
  if (x.phase === 'RADAR') return 'UNDERSTAND';
  if (x.phase === 'DECIDED') return 'DECIDE';
  return 'TRIAGE';
}

/** Read-only archive of pre-v11 data; no auto-conversion of scores/scenarios */
export function migrateFromLegacy(raw: any): {
  decision: Decision | null;
  report: string[];
} {
  const report: string[] = [];
  try {
    const e = emptyDecision();
    const d: Decision = {
      ...e,
      id: raw.id || e.id,
      title: raw.title || 'Archived decision',
      createdAt: raw.createdAt || Date.now(),
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      step: mapOldStep(raw),
      cycleCount: raw.cycleCount || 1,
      brief: {
        ...e.brief,
        decision: raw.brief?.decision || raw.rawInput || '',
        goal: raw.brief?.goal,
        facts: raw.brief?.facts || [],
        unknowns: raw.brief?.unknowns || [],
        assumptions: raw.brief?.assumptions || [],
        values: raw.brief?.values || [],
        constraints: raw.brief?.constraints || [],
        myOptions: (raw.brief?.myOptions || raw.brief?.alternatives || []).map(
          (o: any, i: number) => ({
            id: o.id || `opt_user_${i}`,
            title: o.title || o.tagline || `Option ${i + 1}`,
          })
        ),
        leaningOptionId: raw.brief?.leaningOptionId || 'NONE',
        errorCost: raw.brief?.errorCost || {},
        reversibility: raw.brief?.reversibility || {},
        reviewDates: raw.brief?.reviewDates || raw.reviewDates || [],
      },
      options: [],
      redTeam: [],
      hypotheses: [],
      experiments: [],
      evidence: [],
      journal: [],
      modelSuggestions: {},
      stepHistory: {},
    };

    // Do NOT import scenarios, scores, suggestedCalibration, costOfInaction as user data
    if (raw.scenarios || raw.alternatives?.some((a: any) => a.scenarios)) {
      report.push('Scenarios and probabilities were not migrated (model / disallowed)');
    }
    if (raw.legacySliders || raw.legacyRunway) {
      report.push(
        'Sliders and legacyRunway were not migrated; savings horizon can be entered as text in Constraints'
      );
    }
    if (raw.suggestedCalibration || raw.forecasts?.some((f: any) => f.estimateSource === 'MODEL')) {
      report.push('Model forecasts are not shown as user forecasts');
    }
    if (raw.executiveComment) {
      report.push('executiveComment kept only as archive note (not a verdict)');
      d.modelSuggestions.archivedExecutiveComment = raw.executiveComment;
    }
    if (raw.rawInput) {
      report.push('rawInput available for manual transfer into Brief');
      d.modelSuggestions.archivedRawInput = raw.rawInput;
    }

    return { decision: d, report };
  } catch (err) {
    report.push(`Migration error: ${String(err)}`);
    return { decision: null, report };
  }
}

export function getStoredDecisions(): Decision[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }
    // Archive old keys
    const oldKeys = [
      'bifurcation_decisions_v6',
      'bifurcation_decisions_v2',
      'bifurcation_decisions',
    ];
    for (const k of oldKeys) {
      const old = localStorage.getItem(k);
      if (old) {
        localStorage.setItem(ARCHIVE, old);
        const parsed = JSON.parse(old);
        const reports: string[] = [];
        if (Array.isArray(parsed)) {
          reports.push(`Archived ${parsed.length} records from ${k}`);
          for (const item of parsed.slice(0, 5)) {
            const { report } = migrateFromLegacy(item);
            reports.push(...report);
          }
        }
        localStorage.setItem(MIGRATION_REPORT, JSON.stringify(reports));
        localStorage.removeItem(k);
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function saveDecisions(ds: Decision[]) {
  localStorage.setItem(KEY, JSON.stringify(ds));
}

export const getActiveDecisionId = () => localStorage.getItem(ACTIVE) || '';
export const setActiveDecisionId = (id: string) =>
  localStorage.setItem(ACTIVE, id);
export const getPrivacyAccepted = () =>
  localStorage.getItem(PRIVACY) === 'true';
export const setPrivacyAccepted = (v: boolean) =>
  localStorage.setItem(PRIVACY, String(v));
export const getArchived = () => localStorage.getItem(ARCHIVE);
export const getMigrationReport = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(MIGRATION_REPORT) || '[]');
  } catch {
    return [];
  }
};
