/** Soft applicability check — internal codes stable; UI uses plain labels */

export interface TriageAnswers {
  crisis: boolean;
  onlyValues: boolean;
  costly: boolean;
  hardToUndo: boolean;
  resolvableUnknowns: boolean;
  longHorizon: boolean;
}

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

export const TRIAGE_OUTCOME_LABEL: Record<TriageOutcome, string> = {
  CRISIS_STOP: 'PAUSE',
  VALUES_ONLY: 'VALUES ONLY',
  METHOD_JUSTIFIED: 'CAREFUL PROCESS HELPS',
  OVERKILL: 'LIGHT TOUCH IS FINE',
};

export const TRIAGE_OUTCOME_TEXT: Record<TriageOutcome, string> = {
  CRISIS_STOP:
    'Please get help from a real person first. Pause this decision if you can.',
  VALUES_ONLY:
    'This is mainly about personal values. A short reflection may be enough.',
  METHOD_JUSTIFIED:
    'A careful step-by-step process is useful: the choice is costly, hard to reverse, or has things you can still check.',
  OVERKILL:
    'You can keep it light — try a small step and learn. You may still use the full process if you want.',
};
