/** Triage pure function — international copy */

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

export const TRIAGE_OUTCOME_TEXT: Record<TriageOutcome, string> = {
  CRISIS_STOP:
    'You need a real person or a specialist right now. Postpone the decision if possible. This program is not a substitute for help.',
  VALUES_ONLY:
    'This is about values, not facts. A full cycle may be unnecessary — reflection is enough.',
  METHOD_JUSTIFIED:
    'The method is warranted: cost of error, reversibility, resolvable unknowns, or a long time horizon are present.',
  OVERKILL:
    'Likely overkill — faster to try and see. You can still continue if you want to run the protocol.',
};
