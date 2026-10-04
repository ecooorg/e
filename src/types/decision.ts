/** Bifurcation Engine v11 — domain model */

export type Step =
  | 'TRIAGE'
  | 'BRIEF'
  | 'UNDERSTAND'
  | 'EXPAND'
  | 'ATTACK'
  | 'TEST'
  | 'DECIDE'
  | 'SYNTHESIS'
  | 'LEARN';

export type Source = 'USER_DATA' | 'GENERAL_PATTERN' | 'GUESS';
export type Door = 'ONE_WAY' | 'TWO_WAY';
export type Verifiability = 'TESTABLE' | 'SPECULATION';
export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type EpistemicKind =
  | 'FACT'
  | 'ASSUMPTION'
  | 'INTERPRETATION'
  | 'VALUE'
  | 'UNKNOWN'
  | 'EXTERNAL_VERIFY';
export type EpistemicStatus =
  | 'UNRESOLVED'
  | 'USER_CONFIRMED'
  | 'USER_UNKNOWN'
  | 'EXTERNALLY_VERIFIED'
  | 'REJECTED'
  | 'ACCEPTED_UNCERTAINTY';
export type ErrorDiagnosis =
  | 'DATA'
  | 'ASSUMPTION'
  | 'REASONING'
  | 'EXECUTION'
  | 'LUCK';
export type OptionKind =
  | 'HYBRID_OR_PILOT'
  | 'REVERSIBLE_STEP'
  | 'GET_FACT_FIRST'
  | 'OTHER';
export type ExperimentStatus =
  | 'DRAFT'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED';

export interface StepMeta {
  model: string;
  fallback: boolean;
  at: number;
  durationMs: number;
  stage?: Step;
  cycleId?: string;
  schemaVersion?: number;
}

export interface Triage {
  crisis: boolean;
  crisisConfirmed?: boolean;
  onlyValues: boolean;
  q: {
    costly: boolean;
    hardToUndo: boolean;
    resolvableUnknowns: boolean;
    longHorizon: boolean;
  };
  outcome: 'CRISIS_STOP' | 'VALUES_ONLY' | 'METHOD_JUSTIFIED' | 'OVERKILL';
  confirmed?: boolean;
}

export interface DecisionBrief {
  decision: string;
  deadline?: string;
  goal?: string;
  facts: string[];
  unknowns: string[];
  assumptions: string[];
  values: string[];
  constraints: string[];
  myOptions: { id: string; title: string }[];
  leaningOptionId: string | 'NONE';
  errorCost: {
    preliminary?: Level;
    final?: Level;
    note?: string;
  };
  reversibility: {
    preliminary?: Door | 'UNKNOWN';
    final?: Door | 'UNKNOWN';
    exitCost?: string;
    recoveryPath?: string;
  };
  reviewDates: string[];
  minimalMode?: boolean;
}

export interface NeutralItem {
  id: string;
  original: string;
  kind: 'KEEP' | 'NEUTRALIZE' | 'INTERPRETATION';
  neutralQuestion?: string;
  userChoice: 'ACCEPT' | 'EDITED' | 'REVERT';
  edited?: string;
}

export interface Claim {
  id: string;
  kind: EpistemicKind;
  text: string;
  source: Source;
  sourceType: 'USER' | 'MODEL' | 'EXTERNAL' | 'CALCULATION';
  status: EpistemicStatus;
  owner?: string;
  userImportance?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  evidenceIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Unknown extends Claim {
  question: string;
  whyChangesDecision: string;
  howToFindOut: string;
  effort: 'MINUTES' | 'DAYS' | 'WEEKS';
  branchIfA: { answer: string; leadsTo: string };
  branchIfB: { answer: string; leadsTo: string };
  critical: boolean;
  discarded?: boolean;
  answer?: string;
}

export interface Radar {
  facts: Claim[];
  assumptions: Claim[];
  interpretations: Claim[];
  values: Claim[];
  unknowns: Unknown[];
  needsExternalCheck: Claim[];
  meta: StepMeta;
}

export interface KnowledgeMap {
  known: string[];
  unknown: string[];
  critical: string[];
  quickToGet: string[];
  needsIndependentCheck: string[];
  meta: StepMeta;
  confirmed?: boolean;
}

export interface Evidence {
  id: string;
  claim: string;
  sourceType: 'USER_DOCUMENT' | 'EXTERNAL_SOURCE' | 'CALCULATION' | 'MODEL';
  sourceLabel: string;
  sourceLocator?: string;
  verified: boolean;
  verifiedAt?: number;
  notes?: string;
}

export interface Option {
  id: string;
  title: string;
  description: string;
  byUser: boolean;
  kind?: OptionKind;
  keyAssumption: string;
  exitCost: string;
  cheapestTest: string;
  door: Door;
  realistic: 'YES' | 'NO' | 'UNKNOWN';
  linkedUnknownIds: string[];
}

export interface Objection {
  id: string;
  argument: string;
  hiddenAssumption: string;
  failureMode: string;
  whatMustBeTrueForCritiqueToBeWeak: string;
  verifiability: Verifiability;
  response?: { verdict: 'ACCEPTED' | 'REJECTED'; reason: string };
}

export interface RedTeamRound {
  targetOptionId: string;
  role: 'PREFERRED' | 'OPPOSITE';
  objections: Objection[];
  meta: StepMeta;
}

export interface PreMortem {
  horizonMonths: number;
  causes: {
    text: string;
    verifiability: Verifiability;
    verificationAction?: string;
    relatedHypothesisId?: string;
  }[];
  narrative: string;
  whatDistinguishesFromForecast: string;
  meta: StepMeta;
}

export interface Hypothesis {
  id: string;
  text: string;
  verifiability: Verifiability;
  sourceFindingIds?: string[];
  rewrittenByUser?: string;
  priority?: 1 | 2 | 3;
  selectedByUser?: boolean;
}

export interface ChangeRecord {
  at: number;
  field: string;
  from: string;
  to: string;
  reason: string;
}

export interface ExperimentCard {
  id: string;
  hypothesisId: string;
  whyCritical: string;
  test: string;
  metric: string;
  deadline?: string;
  deadlineWords?: string;
  successThreshold?: string;
  stopThreshold?: string;
  intermediateOutcome?: string;
  ifSuccess?: string;
  ifFailure?: string;
  whatToDoAfterStop?: string;
  whatWouldChangeMyMind?: string;
  validityThreats: { threat: string; protection: string; handled: boolean }[];
  thresholdQuestions: string[];
  priorityLabels?: {
    impact: Level;
    accessibility: Level;
    testErrorCost: Level;
  };
  forecast?: {
    wording: string;
    confidence?: number | 'LOW_NO_DATA';
    rationale?: string;
    horizonDays?: 30 | 90 | 180;
    source: 'USER';
  };
  evpi?: {
    p: number;
    gain: number;
    loss: number;
    testCost: number;
    unit: string;
  };
  status: ExperimentStatus;
  lockedAt?: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  resultValue?: string;
  evidenceIds: string[];
  history: ChangeRecord[];
  thresholdShiftedAfterStart: boolean;
}

export interface HumanDecision {
  kind: 'CHOOSE_OPTION' | 'POSTPONE' | 'RUN_TESTS' | 'REFUSE';
  chosenOptionId?: string;
  whatIDecided: string;
  onWhichValues: string;
  underWhichData: string;
  acceptedUncertainties: string[];
  decidedAt: number;
  supersedes?: string;
}

export interface Synthesis {
  paragraphs: [string, string, string, string];
  derivedNumbers: { value: number; formula: string; operands: number[] }[];
  openGaps: string[];
  needsExternalCheck: string[];
  unverifiedNumbers: string[];
  editedByUser?: string;
  meta: StepMeta;
}

export interface JournalEntry {
  id: string;
  createdAt: number;
  hypothesis: string;
  forecastWording: string;
  confidence?: number | 'LOW_NO_DATA';
  rationale?: string;
  reviewDate: string;
  horizonDays: 30 | 90 | 180;
  supersedesId?: string;
  noResultYet?: boolean;
  fact?: string;
  outcome?: boolean;
  discrepancy?: string;
  errorType?: ErrorDiagnosis;
  diagnosisNote?: string;
  whatIUpdated?: string;
  reviewedAt?: number;
}

export type InteractionState =
  | 'NEED_CONTEXT'
  | 'PREVIEW_READY'
  | 'UNDERSTANDING'
  | 'OPTIONS_READY'
  | 'ATTACK_READY'
  | 'TEST_READY'
  | 'SYNTHESIS_READY'
  | 'USER_SATISFIED';

export interface Decision {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  step: Step;
  interactionState?: InteractionState;
  cycleCount: number;
  parentCycleId?: string;
  triage?: Triage;
  brief: DecisionBrief;
  neutralization?: NeutralItem[];
  neutralizationConfirmed?: boolean;
  radar?: Radar;
  knowledgeMap?: KnowledgeMap;
  options: Option[];
  preferredOptionId?: string;
  oppositeOptionId?: string;
  redTeam: RedTeamRound[];
  preMortem?: PreMortem;
  hypotheses: Hypothesis[];
  experiments: ExperimentCard[];
  evidence: Evidence[];
  decision?: HumanDecision;
  synthesis?: Synthesis;
  journal: JournalEntry[];
  modelSuggestions: Record<string, unknown>;
  stepHistory: Record<string, unknown[]>;
  thirdPersonMode?: boolean;
}

export const SCHEMA_VERSION = 11;

export const LOOPS = [
  { id: 1, label: 'UNDERSTAND', steps: ['BRIEF', 'UNDERSTAND'] as Step[] },
  { id: 2, label: 'EXPAND', steps: ['EXPAND'] as Step[] },
  { id: 3, label: 'ATTACK', steps: ['ATTACK'] as Step[] },
  { id: 4, label: 'VERIFY', steps: ['TEST', 'DECIDE', 'SYNTHESIS'] as Step[] },
  { id: 5, label: 'LEARN', steps: ['LEARN'] as Step[] },
] as const;

export const STAGES: {
  id: Step;
  label: string;
  loop: string;
  article: string;
  human: string;
  model: string;
}[] = [
  {
    id: 'TRIAGE',
    label: 'Start',
    loop: 'PREPARE',
    article: 'Quick start step 1',
    human: 'Checks if help is needed and if a careful process is useful',
    model: 'Not used yet',
  },
  {
    id: 'BRIEF',
    label: 'Your story',
    loop: 'UNDERSTAND',
    article: '§6; L1',
    human: 'Describes the situation in their own words',
    model: 'Not used yet',
  },
  {
    id: 'UNDERSTAND',
    label: 'Clarify',
    loop: 'UNDERSTAND',
    article: 'L1; §3.2; §8.2 stages 1–2',
    human: 'Confirms neutralization; answers unknowns; assigns owner',
    model: 'Neutralizes; maps 6 categories; formulates unknowns; knowledge map',
  },
  {
    id: 'EXPAND',
    label: 'Options',
    loop: 'EXPAND',
    article: 'L2; §8.2 stage 3',
    human: 'Marks realistic options; adds own',
    model: '3–5 additional options',
  },
  {
    id: 'ATTACK',
    label: 'Stress-test',
    loop: 'ATTACK',
    article: 'L3; §8.2 stages 4–5',
    human: 'Picks pair; answers objections; selects 1–3 hypotheses',
    model: 'Red team both sides; pre-mortem; hypothesis candidates',
  },
  {
    id: 'TEST',
    label: 'Test ideas',
    loop: 'VERIFY',
    article: 'L4; §7; App.A; §8.2 stages 6–7',
    human: 'Sets thresholds, forecast; locks card',
    model: 'Test draft, metrics, threshold questions',
  },
  {
    id: 'DECIDE',
    label: 'Decide',
    loop: 'LEARN',
    article: 'L5; §9',
    human: 'Records decision, values, and data',
    model: 'On demand: observable success criteria wording',
  },
  {
    id: 'SYNTHESIS',
    label: 'Plan',
    loop: 'LEARN',
    article: 'L5; §8.2 stage 9',
    human: 'Reads, edits, exports',
    model: 'Writes a four-paragraph work plan',
  },
  {
    id: 'LEARN',
    label: 'Learn',
    loop: 'LEARN',
    article: '§10',
    human: 'Enters fact and discrepancy type',
    model: 'Optionally asks review questions',
  },
];

export function emptyBrief(): DecisionBrief {
  return {
    decision: '',
    facts: [],
    unknowns: [],
    assumptions: [],
    values: [],
    constraints: [],
    myOptions: [],
    leaningOptionId: 'NONE',
    errorCost: {},
    reversibility: {},
    reviewDates: [],
    minimalMode: true,
  };
}

export function emptyDecision(): Decision {
  return {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: 'My choice',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    step: 'BRIEF',
    interactionState: 'NEED_CONTEXT',
    cycleCount: 1,
    brief: emptyBrief(),
    options: [],
    redTeam: [],
    hypotheses: [],
    experiments: [],
    evidence: [],
    journal: [],
    modelSuggestions: {},
    stepHistory: {},
  };
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeReviewDates(from: Date = new Date()): string[] {
  return [addDays(from, 30), addDays(from, 90), addDays(from, 180)];
}
