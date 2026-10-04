/** Applicability check (method step 1) — plain labels for UI and translation */

export interface TriageAnswers {
  crisis: boolean;
  onlyValues: boolean;
  costly: boolean;
  hardToUndo: boolean;
  resolvableUnknowns: boolean;
  longHorizon: boolean;
}

/** Internal codes (stable for storage). Display strings are separate. */
export type TriageOutcome =
  | 'CRISIS_STOP'
  | 'VALUES_ONLY'
  | 'METHOD_JUSTIFIED'
  | 'OVERKILL';

export function triage(answers: TriageAnswers): TriageOutcome {
  if (answers.crisis) return 'CRISIS_STOP';
  if (answers.onlyValues) return 'VALUES_ONLY';
  const yesCount = [
    answers.costly,
    answers.hardToUndo,
    answers.resolvableUnknowns,
    answers.longHorizon,
  ].filter(Boolean).length;
  if (yesCount >= 2) return 'METHOD_JUSTIFIED';
  return 'OVERKILL';
}

/** Short labels shown in the UI (avoid jargon that auto-translate mangles). */
export const TRIAGE_OUTCOME_LABEL: Record<TriageOutcome, string> = {
  CRISIS_STOP: 'PAUSE',
  VALUES_ONLY: 'VALUES ONLY',
  METHOD_JUSTIFIED: 'METHOD USEFUL',
  OVERKILL: 'NOT NEEDED',
};

export const TRIAGE_OUTCOME_TEXT: Record<TriageOutcome, string> = {
  CRISIS_STOP:
    'Please get help from a real person first. Pause this decision if you can. This program is not a replacement for help.',
  VALUES_ONLY:
    'This is mainly about personal values, not missing facts. A short reflection may be enough; the full method is optional.',
  METHOD_JUSTIFIED:
    'The full method is useful here: the choice is costly, hard to reverse, has unknowns you can check, or has long-term effects.',
  OVERKILL:
    'The full method is probably not needed — you can try a small step and learn from the result. You may still continue if you want.',
};
