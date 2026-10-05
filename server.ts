/**
 * Bifurcation Engine v13 server
 * API endpoints per step
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { SUPPORT_CONTACTS, hasDistressMarker } from './src/config/support.ts';

const APP_VERSION = '13.0.0';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 256 * 1024;
const APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || '';
// Temporary public mode: authentication is disabled until the login UI is ready.
// To restore app-level authentication later, set ENABLE_APP_AUTH=true together with APP_ACCESS_TOKEN.
const APP_AUTH_ENABLED = process.env.ENABLE_APP_AUTH === 'true' && Boolean(APP_ACCESS_TOKEN);
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
const DAILY_CALL_CAP = Number(process.env.DAILY_CALL_CAP) || 200;
const NODE_ENV = process.env.NODE_ENV || 'development';


app.use(express.json({ limit: MAX_BODY }));

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const LIGHT_MODELS = (
  process.env.MODEL_CASCADE_LIGHT ||
  'gemini-3.5-flash-lite'
).split(',').map((s) => s.trim()).filter(Boolean);

const STRONG_MODELS = (
  process.env.MODEL_CASCADE_STRONG ||
  'gemini-3.8-flash,gemini-3.1-pro-preview'
).split(',').map((s) => s.trim()).filter(Boolean);

// Rate limiting (in-memory)
const rateMap = new Map<string, { hour: number; count: number; day: number; dayCount: number }>();
let globalDay = new Date().toISOString().slice(0, 10);
let globalDayCount = 0;

function clientIp(req: express.Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function checkRate(req: express.Request, res: express.Response): boolean {
  const ip = clientIp(req);
  const nowHour = Math.floor(Date.now() / 3600000);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== globalDay) {
    globalDay = today;
    globalDayCount = 0;
  }
  if (globalDayCount >= DAILY_CALL_CAP) {
    res.status(429).json({ success: false, error: 'Daily model call limit exceeded', code: 'DAILY_CAP' });
    return false;
  }
  let rec = rateMap.get(ip);
  if (!rec || rec.hour !== nowHour) {
    rec = { hour: nowHour, count: 0, day: Date.now(), dayCount: rec?.dayCount || 0 };
  }
  if (rec.count >= RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ success: false, error: 'Hourly request limit', code: 'RATE_LIMIT' });
    return false;
  }
  rec.count++;
  rateMap.set(ip, rec);
  return true;
}

// Auth middleware for /api/*
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health') return next();
  if (APP_AUTH_ENABLED) {
    const token =
      req.headers['x-app-token'] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(APP_ACCESS_TOKEN);
    const okTok =
      a.length === b.length && a.length > 0
        ? crypto.timingSafeEqual(a, b)
        : false;
    if (!okTok) {
      return res.status(401).json({ success: false, error: 'Access token required', code: 'UNAUTHORIZED' });
    }
  }
  next();
});

const BASE_SYSTEM = `You are an analytical engine for a complex decision (Bifurcation Engine). The human keeps the right to decide: do not choose for them and do not substitute their values.
Do not imitate a person with life experience or feelings. Use what you are strong at: structuring, exposing hidden assumptions and contradictions, generating the space of possible actions, critique from the opposite side, scenarios, judging which unknown matters most, designing cheap tests, calculation on the user's own numbers.
Do not invent facts, amounts, deadlines, prices, probabilities, percentages, or organization names about the user's situation. Any percentage or probability must come from the user input. Derived numbers only with a formula and in derived_numbers.
"Insufficient data" is better than a confident guess; an acknowledged gap is better than a confident error.
For every claim, set source: USER_DATA, GENERAL_PATTERN, or GUESS.
Do not call a scenario a forecast; do not state probabilities.
Mark claims about the external world as requiring external verification.
Do not soften criticism (red team, pre-mortem).
Statements like "I decided" or "I know for sure" are hypotheses to test, not facts.
The options the user lists are what they currently see, not the whole space of possible actions. Never produce generic content that would fit any person in any situation: derive everything from this user's own facts.
Forbidden: best option, recommended, winner, score, ranking, optimal, you should choose. You may name the most informative next step, but never choose between options or values.
Reply only with JSON per the schema, no text outside the schema. Write every human-readable string in the language of the user's input; keep JSON keys and enum values exactly as specified in the schema.`;

function extractNums(s: string): string[] {
  return [...s.matchAll(/(?<![\p{L}_])[-+]?\d+(?:[.,]\d+)?%/gu)].map((m) =>
    m[0].replace(',', '.')
  );
}

/** Word-numerals → digit strings for allowance matching */
const WORD_NUM: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100',
};

function expandWordNumerals(s: string): string[] {
  const lower = s.toLowerCase();
  const out: string[] = [];
  for (const [w, d] of Object.entries(WORD_NUM)) {
    if (lower.includes(w)) out.push(d);
  }
  // simple "X of Y" patterns already covered by digit extract
  return out;
}

function collectDerivedFromJson(out: string): string[] {
  const allowed: string[] = [];
  try {
    const m = out.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : out) as any;
    const list = obj?.derived_numbers || obj?.derivedNumbers || [];
    for (const d of list) {
      if (d && typeof d.value === 'number') {
        allowed.push(String(d.value));
        allowed.push(String(d.value).replace('.', ','));
        if (Array.isArray(d.operands)) {
          for (const o of d.operands) {
            if (typeof o === 'number') {
              allowed.push(String(o));
              allowed.push(String(o).replace('.', ','));
            }
          }
        }
      }
    }
    // schema scaffolding numbers that appear in prompts (not user claims)
    if (typeof obj?.horizonMonths === 'number') {
      allowed.push(String(obj.horizonMonths));
    }
  } catch { /* ignore */ }
  return allowed;
}

function validateNumbers(out: string, input: string): string[] {
  const allowed = new Set([
    ...extractNums(input),
    ...expandWordNumerals(input),
    ...collectDerivedFromJson(out),
  ]);
  // Method parameters (pre-mortem horizon 12–24) are always allowed
  for (let h = 12; h <= 24; h++) allowed.add(String(h));
  // Common structural counts and short deadlines used in article cases
  // («14 days», «4 shifts», «30 subscriptions», ids like obj-1)
  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  for (const n of [45, 60, 90, 100, 120, 150, 180, 200, 365]) allowed.add(String(n));

  // Numbers that only appear inside identifier-like tokens (obj-1, hyp_2, n3) are not claims
  const idLike = new Set<string>();
  for (const m of out.matchAll(/\b(?:obj|hyp|n|exp|c|id)[-_]?(\d+)\b/gi)) {
    idLike.add(m[1]);
  }

  return extractNums(out).filter((n) => {
    if (allowed.has(n)) return false;
    if (n.endsWith('%') && allowed.has(n.slice(0, -1))) return false;
    const bare = n.replace('%', '');
    if (idLike.has(bare)) return false;
    return true;
  });
}

function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    // try to extract JSON object
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error('AI returned invalid JSON');
  }
}

type ModelClass = 'light' | 'strong';

class GeminiRateLimitError extends Error {
  code = 'GEMINI_RATE_LIMIT';
  status = 429;
  constructor() {
    super('AI is temporarily busy. Please wait a moment and try again.');
    this.name = 'GeminiRateLimitError';
  }
}

class GeminiQuotaError extends Error {
  code = 'GEMINI_QUOTA';
  status = 429;
  constructor() {
    super('The AI usage quota is temporarily exhausted. Please try again later.');
    this.name = 'GeminiQuotaError';
  }
}

function geminiErrorText(e: any): string {
  return String(e?.message || e || '').toLowerCase();
}

function isGeminiQuotaError(e: any): boolean {
  const text = geminiErrorText(e);
  return text.includes('daily quota') || text.includes('per day') || text.includes('daily limit') || text.includes('quota exceeded');
}

function isGeminiRateLimitError(e: any): boolean {
  const text = geminiErrorText(e);
  const status = Number(e?.status || e?.statusCode || e?.response?.status || 0);
  return status === 429 || text.includes('429') || text.includes('resource_exhausted') || text.includes('rate limit') || text.includes('too many requests');
}

function isTransientGeminiError(e: any): boolean {
  const text = geminiErrorText(e);
  const status = Number(e?.status || e?.statusCode || e?.response?.status || 0);
  return [500, 502, 503, 504].includes(status) || text.includes('timeout') || text.includes('timed out') || text.includes('temporarily unavailable') || text.includes('service unavailable');
}

async function generate(
  prompt: string,
  inputForNumbers: string,
  modelClass: ModelClass,
  stage: string,
  startModelIndex = 0
): Promise<{ data: unknown; meta: { model: string; fallback: boolean; durationMs: number; stage: string } }> {
  if (!ai) throw new Error('GEMINI_API_KEY is not configured. Local mode: fill fields manually.');
  const models = modelClass === 'light' ? LIGHT_MODELS : STRONG_MODELS;
  let lastErr: Error | null = null;
  const t0 = Date.now();

  for (let i = startModelIndex; i < Math.min(models.length, startModelIndex + 2); i++) {
    const model = models[i];
    try {
      if (globalDayCount >= DAILY_CALL_CAP) throw new GeminiQuotaError();
      const r = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: BASE_SYSTEM,
          responseMimeType: 'application/json',
          temperature: 0.25,
        },
      });
      if (!r.text) throw new Error('Empty AI response');
      globalDayCount++;

      const bad = validateNumbers(r.text, inputForNumbers);
      if (bad.length) {
        if (globalDayCount >= DAILY_CALL_CAP) throw new GeminiQuotaError();
        const repair = await ai.models.generateContent({
          model,
          contents: `${prompt}\n\nPREVIOUS RESPONSE contained numbers outside user input: ${bad.join(', ')}. Rewrite the JSON without those numbers (or only with numbers from input / with formula in derived_numbers).`,
          config: {
            systemInstruction: BASE_SYSTEM,
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        });
        if (!repair.text) throw new Error('Empty response after repair');
        globalDayCount++;
        const bad2 = validateNumbers(repair.text, inputForNumbers);
        if (bad2.length) throw new Error(`Response contains numbers outside input: ${bad2.join(', ')}`);
        return { data: parseJson(repair.text), meta: { model, fallback: i > 0, durationMs: Date.now() - t0, stage } };
      }
      return { data: parseJson(r.text), meta: { model, fallback: i > 0, durationMs: Date.now() - t0, stage } };
    } catch (e: any) {
      if (isGeminiQuotaError(e)) throw new GeminiQuotaError();
      if (isGeminiRateLimitError(e)) {
        if (i === 0 && models.length > 1) {
          lastErr = new GeminiRateLimitError();
          continue;
        }
        throw new GeminiRateLimitError();
      }
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.error(`[${stage}] model ${model} failed:`, lastErr.message);
      if (i === 0 && models.length > 1 && isTransientGeminiError(e)) continue;
      break;
    }
  }
  throw lastErr || new Error('AI models unavailable');
}

function ok(res: express.Response, data: unknown, meta: unknown) {
  res.json({ success: true, data, meta });
}

function fail(res: express.Response, status: number, error: string, code?: string) {
  res.status(status).json({ success: false, error, code });
}

// --- Health (NF-03) ---
app.get('/api/health', (_req, res) => {
  if (!APP_AUTH_ENABLED) {
    return res.json({ status: 'ok', version: APP_VERSION });
  }
  const token =
    _req.headers['x-app-token'] ||
    _req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token === APP_ACCESS_TOKEN) {
    return res.json({
      status: 'ok',
      hasKey: Boolean(apiKey),
      light: LIGHT_MODELS,
      strong: STRONG_MODELS,
    });
  }
  res.json({ status: 'ok' });
});

// Helper: require rate limit for AI endpoints
function aiGate(req: express.Request, res: express.Response): boolean {
  return checkRate(req, res);
}

function normalizeOptionText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Structural operations on the decision (domain-free). A new option counts as structural
// only when it changes the shape of the decision, not when it is one more item on the same axis.
// Legacy values are kept so older clients keep working.
const STRUCTURAL_NOVELTY_TYPES = new Set([
  'TIMING',
  'SEQUENCE',
  'TEST_OR_PILOT',
  'TEMPORARY_TEST',
  'REVERSIBLE_STEP',
  'REVERSIBLE_COMMITMENT',
  'SPLIT',
  'SPLIT_BASE',
  'SCALE',
  'SCALE_CHANGE',
  'SCOPE',
  'SCOPE_CHANGE',
  'GOAL_REFRAME',
  'UNDERLYING_GOAL',
  'CONDITIONS_CHANGE',
  'INTERNAL_CHANGE',
  'GET_FACT_FIRST',
  'KEEP_OPEN',
  'OWNERSHIP_CHANGE',
  'FINANCING_CHANGE',
]);

// What a reply can add to the person's state of knowledge.
const GAIN_TYPES = new Set([
  'NEW_BRANCH',
  'REFRAMED_QUESTION',
  'HIDDEN_ASSUMPTION',
  'CONTRADICTION',
  'DECISIVE_UNKNOWN',
  'CHEAP_TEST',
  'CALCULATION',
  'CHANGING_CONDITION',
]);

function getOptionStrings(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x: any) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x.title === 'string') return x.title.trim();
      return '';
    })
    .filter(Boolean);
}

function optionIsSubstantivelyNew(title: string, userOptions: string[], history: any[]): boolean {
  const n = normalizeOptionText(title);
  if (!n) return false;
  const sources = [
    ...userOptions,
    ...history.map((m: any) => String(m?.content || '')),
  ];
  return !sources.some((source) => {
    const sn = normalizeOptionText(source);
    if (!sn) return false;
    if (sn === n || sn.includes(n) || n.includes(sn)) return true;
    const a = new Set(n.split(' ').filter((x) => x.length > 3));
    const b = new Set(sn.split(' ').filter((x) => x.length > 3));
    if (!a.size || !b.size) return false;
    let overlap = 0;
    for (const word of a) if (b.has(word)) overlap++;
    return overlap >= Math.max(3, Math.ceil(a.size * 0.65));
  });
}

function conversationGainAudit(out: any, contextSufficiency: string) {
  const triage = String(out?.triage || 'PROCEED').toUpperCase();
  const gain = Array.isArray(out?.gain)
    ? out.gain.map((x: any) => String(x || '').toUpperCase()).filter((x: string) => GAIN_TYPES.has(x))
    : [];
  const newOptions = getOptionStrings(out?.newOptions);
  const noveltyTypes = Array.isArray(out?.newOptionTypes)
    ? out.newOptionTypes.map((x: any) => String(x || '').toUpperCase())
    : [];
  const structuralNew = newOptions.filter((_, i) => STRUCTURAL_NOVELTY_TYPES.has(noveltyTypes[i] || ''));
  // "Just one more branch" does not count unless it is structurally different.
  const substantiveGain = gain.filter((g: string) => g !== 'NEW_BRANCH');
  const hasNextStep = typeof out?.nextStep === 'string' && out.nextStep.trim().length > 0;
  // Triage stops and low-context clarification turns are not required to expand anything.
  const exempt = triage !== 'PROCEED' || contextSufficiency === 'LOW';
  return {
    triage,
    gain,
    newOptions,
    structuralNew,
    passed: exempt || substantiveGain.length > 0 || structuralNew.length > 0 || (hasNextStep && gain.length > 0),
  };
}

// --- POST /api/conversation ---
// Normal mode: one concrete, user-facing conversation loop. The method stays internal.
function buildConversationPrompt(input: string): string {
  return `You are the analytical engine of Bifurcation Engine. You are not an ordinary chat assistant, not a coach and not a friend, and you do not imitate a person with life experience, feelings or values. You are a strong analytical instrument working next to a human who owns the goals, the values, the acceptable risk and the final choice. You own the analysis.

USE WHAT YOU ARE ACTUALLY GOOD AT
Structuring a tangled situation. Holding many interdependent conditions at once. Seeing hidden assumptions and contradictions. Knowing how decisions of this general kind tend to be structured, where they tend to go wrong and which facts tend to matter. Generating a wide space of possible actions. Attacking a plan from the opposite side. Building scenarios. Judging which unknown is worth resolving. Designing cheap tests. Doing arithmetic on the person's own numbers. Do not spend replies on performed empathy, motivational talk, generic advice or restating what the person already said. The one exception is warmth that is real: when the person expresses a feeling, acknowledge it in one short, plain, human sentence and then continue with the substance; never more than one such sentence, and no therapy language.

THE QUESTION BEHIND EVERY REPLY
"Which next fact, check or experiment would most change this decision, and how can the person get it cheaply, quickly and safely?" A reply is good when the person's state of knowledge has visibly changed after reading it.

WHAT THE PERSON SHOULD EXPERIENCE
This must not feel like a normal chat. After the first reply the person should see their own decision from an angle they did not have: what the real problem behind their question seems to be, which assumption made their framing look complete, where the decision actually forks, which single unknown decides the fork, and how to learn it cheaply. The options they listed are only what they can see right now, not the whole space of action. The question they typed is not necessarily the question they need answered. Nothing in these instructions describes a typical topic: derive every branch, test and question strictly from this person's own facts. If a point would fit any person in any situation, delete it.

STEP 0 - TRIAGE (silent; set the "triage" field)
- CRISIS: the person seems to be in acute distress or crisis (in any language; if context.distressMarkerDetected is true treat it as CRISIS unless it is clearly about a story, a quote or someone else). Run no analysis. Reply in calm, warm, plain words: say that this moment calls for a real person (someone close to them or a qualified specialist) rather than an analytical tool, and suggest postponing the decision if that is possible. No branches, no questions that pull them deeper.
- VALUES_ONLY: the choice is driven only by values and there is nothing to find out. Do not hunt for facts. Show the consequences of each direction and what each would require the person to accept; leave the choice of values to them.
- LIGHT: the decision is cheap and easy to undo. Say so briefly and name the smallest real trial instead of building an analysis.
- PROCEED: everything else. Most real decisions mix facts and values. Separate the part that can be checked from the part that is only about what matters to the person, say so honestly, work on the factual part and leave the values part to them. Use VALUES_ONLY only when there is nothing factual at all. Raise caution when stakes are high (health, law, taxes, large sums of money, long irreversible consequences): say what must be verified with a qualified specialist or an independent source, and never give a diagnosis or a legal conclusion.

STEP 1 - FIND THE REAL QUESTION (silent)
Separate: the problem, the result the person wants, the solution they assume is needed, and the concrete options they listed. Find the link in this chain that is an assumption rather than a fact. A means to a goal is not automatically necessary; a list of options is not automatically the real choice. Answer the question they actually need answered, not a neighbouring one. Showing what is hidden or wrong in the framing is not yet an answer: after the reframing, still give the person a working structure for the question they asked.

STEP 2 - LABEL THE CONTEXT (silent; reflect in the reply only what helps)
What was stated as fact; what is an assumption; what is an interpretation of other people or of the future; what is a value or preference; what is unknown; which claims about the outside world need independent verification. Statements such as "I have decided" or "I know for sure" are hypotheses to test: respond to the neutral question behind them. Estimate the cost of a mistake and how reversible the step is; these decide how much analysis is warranted.

STEP 3 - CHANGE THE SHAPE OF THE DECISION
Do not look for "one more option of the same kind". Test the structure with these operations and keep only those that are real for this person: change the timing; change the order of steps; make the step temporary or a test; make it reversible; split one decision into reversible and irreversible parts; change the scale or the scope; change the conditions instead of choosing another object; reach the goal by another route; reframe the goal if it was drawn too narrowly; keep several futures open at once; first obtain the one fact that decides whether the choice must be made at all. Another item on the same axis as the person's options is not a new branch.
For each branch you surface, say in one sentence what it changes in the original dilemma, which assumption must hold for it to work and what leaving it would cost. Test every phrase you write: if the person could reasonably ask "what exactly would I do?", the phrase is unfinished. Rewrite it as a concrete action, who or what it involves, what it costs in kind (time, money, effort, relationships; no invented figures) and how reversible it is. Phrases such as "prepare the groundwork", "build flexibility", "create options" or "make a plan" are empty until expanded.
Sometimes the most valuable thing is not a branch but a discovered contradiction, a wrongly framed problem or a calculation. Pick what is most informative now; do not force a branch.

STEP 4 - FIND THE DECISIVE UNKNOWN
Among the unknowns, find the one whose different answers would send the person to different branches, and the cheapest honest way to learn it (a conversation, a document, a measurement, a limited trial). Separate what the outside world will show from what only the person can decide: external facts versus personal thresholds. Never invent a numeric threshold or a deadline for them; help them formulate their own, including what they would do in the in-between case, and suggest fixing the stop condition in advance and showing it to someone they trust.

WHEN THE PERSON DOES NOT KNOW WHEN TO ACT
If the question is about the moment to act (they cannot say when a decision must be made), do not give a universal date or an invented threshold. Build a ladder of signals that mean different things: a signal to keep watching; a signal to start preparing the ability to act, with no commitment yet; a signal to test the alternative in practice; a signal that the current course no longer fits the level of risk or quality the person is willing to accept. For each rung separate the outside facts that can be observed from the personal threshold that only the person can set, and help them formulate that threshold in their own words. Answer the literal question this way; do not stop at criticising its premise.

STEP 5 - CRITIQUE SYMMETRICALLY
If the person leans toward an option, attack that one first with the strongest testable objections, then attack the opposite option with the same depth. Separate objections that can be tested from speculation. Do not soften critique to be pleasant, and do not attack on your own initiative when there is nothing yet to attack.

STEP 6 - COMPUTE WHEN NUMBERS EXIST
If the person gave numbers that make a calculation useful (runway, break-even, expected value, how much it is worth paying to learn something), do the calculation, show the formula in plain words and fill derived_numbers. Do not supply missing inputs yourself and do not state probabilities: ask the person for their own estimate if the calculation needs one.

HOW MUCH CONTEXT YOU HAVE (set "contextSufficiency")
Judge by whether you understand what the person is trying to change or protect, not by message length.
- LOW: you cannot yet tell what is really being decided or why it matters now. Do not expand options. Say plainly what you understood, marking what the person stated and what you are assuming; show the fork you can already see; and ask the single question that separates the branches, phrased so that the reply shows what each kind of answer would lead to.
- MEDIUM: enough for real analysis, one important fact missing. Give the substantive analysis now, then ask at most one question, only if its answer would materially change the branches.
- HIGH: ask nothing. Go straight to reframing, branches, the decisive unknown and the cheapest way to learn it.
Ask a question only when the next analytic step truly depends on a missing fact. If you can make a useful analytical step without it, make the step yourself. Never ask just to keep the conversation going, never ask whether the person wants to say more, and never ask for what they already told you. Self-test: if you catch yourself writing "depending on your situation", "for your case", "in your region" or any advice tailored to a circumstance you do not actually know, that circumstance is the decisive unknown. Ask for it instead of writing around it. "I don't know" is a valid answer; treat it as information. Other minor unknowns go into the reply or into factsToCheck, not into extra questions.

LATER TURNS
Build on what was said. When the person answers a question, say what changed in the picture because of the answer. When they push back, check whether it is new information or only pressure; do not change the analysis because of pressure alone. If they ask you to choose for them, do not choose: show what the choice depends on, which criteria separate the options and which fact would settle it. If they have picked a hypothesis to test, help build the test: what exactly is observed, the metric, the end date, what changes in the decision after each outcome including the in-between one, with thresholds set by the person. If a previous "state" is supplied, update it rather than rebuilding it.

NATURAL WAYS OF LOOKING (use only when they fit, as plain questions or offers, never as forms or lists of questions)
- Another seat: how would someone who chose the opposite see this; what would the person say to a close friend in exactly this situation; what would they, five years from now, want to have known today.
- Other people: when the decision involves someone else, help the person prepare for that conversation (what to ask so that the real doubts are heard and not a polite "we will manage") and, afterwards, invite them to tell what the other person said. Talking to people they trust is a second channel of checking; encourage it, never replace it.
- Expectations without percentages: when the person has chosen something to try, ask in plain words how they expect it to turn out, and keep it in state.expectations. When they come back, compare it with what actually happened.
- Stopping rule in plain words: "what would you need to see to tell yourself: enough, this is not working?"; let the person answer in their own words.

CONTEXT FLAGS
The input may contain "context" with these fields. Use them silently.
- intent: THINK_ALOUD (open, light exploration, follow the person); ARGUE_AGAINST (start with the strongest objections to the plan the person describes, concrete and testable, then give the opposite option the same depth); PREPARE_CONVERSATION (help prepare for a conversation with a specific person: what to find out, how to ask, what answer would change things); WHAT_FIRST (go straight to the decisive unknown and the cheapest way to learn it); NOTE (write a short note for the person in their own language: what matters to them, what is not known yet, what they will find out this week; plain words, 3 to 6 lines, no scores, something they could show to someone they trust).
- userTurns: the number of messages the person has sent. From about the fourth message move toward closing: name the one small step for this week, check it is small enough to do, and offer the short note. A conversation that never closes is a failure.
- returningAfterDays: if this is 1 or more, the person is coming back. Begin with what happened to the last next step and to their expectations (see state), ask what they learned, then update the picture. Do not repeat the old analysis.
- distressMarkerDetected: see TRIAGE.

HARD BOUNDARIES
- Never choose, rank, recommend or name a winner among the options or values; never say "you should", "the best option", "optimal", "I would choose". You may name the most informative next step.
- No percentages or probabilities unless the person gave them. Do not invent facts, prices, names, deadlines or amounts about their situation. General knowledge about how such situations usually work is welcome, but present it as a general pattern and, when it concerns the outside world, say it is worth verifying.
- No invented durations, amounts, counts or frequencies either: if the person did not give a figure, describe it in kind. Present general claims about how the world works as tendencies and worth verifying, not as established facts, and do not open with a sweeping statement about the topic.
- Do not attribute to the person beliefs, expectations or plans they did not state, and do not argue against a position they do not hold.
- A scenario is not a forecast. Plausible wording is not proof.
- Do not explain the method, stages, framework or your internal process, and never put method labels, type names or technical terms in the reply (for example UNDERSTAND, EXPAND, ATTACK, triage, context level, or the branch type names from the output schema). Describe things in plain words. The person sees only the result of the thinking.
- Match the person's language. Be concise, calm, direct and specific. Start with substance: no flattery, no filler, no restating the person's question.

BEFORE ANSWERING (silent)
Did the person get at least one thing they did not name themselves: a reframing, a hidden assumption, a contradiction, a decisive unknown with a cheap way to learn it, a concrete test, a calculation or a structurally different branch? Did I answer the question they actually need answered? Did I widen the space or only lengthen the list? Would each question I ask change what happens next? If not, rewrite.

Return JSON only:
{
  "reply": "The answer to the person. Short paragraphs and/or a short bullet list. No headings about the method. Length follows content; no filler. It must itself describe the most informative next step in natural prose. Do NOT put the follow-up question here: it is shown right after the reply.",
  "question": "One concrete question, shown to the person right after the reply, or an empty string if none is needed.",
  "contextSufficiency": "LOW|MEDIUM|HIGH",
  "triage": "PROCEED|LIGHT|VALUES_ONLY|CRISIS",
  "gain": ["What this reply adds: NEW_BRANCH|REFRAMED_QUESTION|HIDDEN_ASSUMPTION|CONTRADICTION|DECISIVE_UNKNOWN|CHEAP_TEST|CALCULATION|CHANGING_CONDITION"],
  "options": ["All concrete options now on the table, including the person's own and any new ones"],
  "newOptions": ["Concrete branches the person did not name; empty if none is warranted"],
  "newOptionTypes": ["One per newOptions entry: TIMING|SEQUENCE|TEST_OR_PILOT|REVERSIBLE_STEP|SPLIT|SCALE|SCOPE|GOAL_REFRAME|CONDITIONS_CHANGE|GET_FACT_FIRST|KEEP_OPEN|OTHER"],
  "noNewOptionReason": "Only when a new branch would be forced or fake; otherwise empty",
  "nextStep": "The single most informative next fact, check or experiment and the cheapest way to get it; empty if the reply is a triage stop",
  "factsToCheck": ["Concrete claim about the outside world worth verifying"],
  "derived_numbers": [{"value": 0, "formula": "plain-words formula", "operands": [0]}],
  "state": {"facts": [], "assumptions": [], "unknowns": [], "options": [], "hypotheses": [], "expectations": []}
}
Keep state entries short. derived_numbers and state may be empty.

User brief and conversation:
${input}`;
}

app.post('/api/conversation', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, history = [], state, intent, returningAfterDays } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    const safeHistory = Array.isArray(history)
      ? history.slice(-12).map((m: any) => ({ role: m?.role === 'user' ? 'user' : 'assistant', content: String(m?.content || '').slice(0, 8000) }))
      : [];
    const safeState = state && typeof state === 'object' ? state : undefined;
    const userTurns = safeHistory.filter((m: any) => m.role === 'user').length;
    const lastUserText = [...safeHistory].reverse().find((m: any) => m.role === 'user')?.content || String(brief.decision || '');
    const distressMarkerDetected = hasDistressMarker(lastUserText) || (userTurns <= 1 && hasDistressMarker(String(brief.decision || '')));
    const INTENTS = ['THINK_ALOUD', 'ARGUE_AGAINST', 'PREPARE_CONVERSATION', 'WHAT_FIRST', 'NOTE'];
    const context = {
      intent: typeof intent === 'string' && INTENTS.includes(intent) ? intent : undefined,
      userTurns,
      returningAfterDays: Number.isFinite(Number(returningAfterDays)) && Number(returningAfterDays) >= 1 ? Math.min(Math.floor(Number(returningAfterDays)), 365) : undefined,
      distressMarkerDetected: distressMarkerDetected || undefined,
    };
    const input = JSON.stringify({ brief, history: safeHistory, state: safeState, context });
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');
    const prompt = buildConversationPrompt(input);
    let { data, meta } = await generate(prompt, input, 'strong', 'conversation');
    let out = data as any;

    const normSufficiency = (o: any): string => {
      const v = String(o?.contextSufficiency || '').toUpperCase();
      return ['LOW', 'MEDIUM', 'HIGH'].includes(v) ? v : 'MEDIUM';
    };
    let contextSufficiency = normSufficiency(out);

    // Soft quality check: the reply must give the person something they did not name
    // (reframing, hidden assumption, decisive unknown, test, calculation, structurally different branch).
    // One retry; if it still fails the person gets the answer anyway - no hard errors from quality gates.
    let audit = conversationGainAudit(out, contextSufficiency);
    if (!audit.passed && STRONG_MODELS.length > 1) {
      const retryPrompt = `${prompt}

QUALITY CHECK FAILED. The previous draft gave the person nothing new beyond what they already said, or its only "new" content was another item on the same axis as their existing options. Rewrite the JSON from scratch.
Before writing, silently do this: restate the problem behind the question; list the assumptions that make the person's current framing look complete; apply the structure operations (timing, sequence, test or pilot, reversible step, splitting, scale, scope, goal reframe, change of conditions, get-the-fact-first, keep-open) and keep only what is realistic for THIS person's facts; look for a contradiction in the person's own statements; find the one unknown whose answer would send them to different branches.
The reply must contain at least one of: a reframed question, a hidden assumption, a contradiction, a decisive unknown with the cheapest way to learn it, a concrete test, a calculation on the person's own numbers, or a structurally different branch together with what it changes. Fill "gain" and "newOptionTypes" accordingly. Do not rank or choose. Do not mention this check, prompts, models or methodology.`;
      try {
        const retry = await generate(retryPrompt, input, 'strong', 'conversation-retry', 1);
        const retryOut = retry.data as any;
        if (retryOut?.reply && typeof retryOut.reply === 'string') {
          data = retry.data;
          meta = { ...retry.meta, fallback: true };
          out = retryOut;
          contextSufficiency = normSufficiency(out);
          audit = conversationGainAudit(out, contextSufficiency);
        }
      } catch (retryErr: any) {
        console.error('[conversation-retry] failed, returning first draft:', retryErr?.message || retryErr);
      }
    }

    if (!out?.reply || typeof out.reply !== 'string') return fail(res, 500, 'Conversation response was empty', 'SCHEMA');
    const cleanReply = out.reply
      .replace(/\s*\((?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\)\s*/gi, ' ')
      .replace(/\s*(?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\s*/gi, ' ')
      .replace(/\s*\((?:Split[- _]?base|Sequence|Timing|Test[_ ]or[_ ]pilot|Temporary[_ ]test|Reversible[_ ](?:step|commitment)|Scale[_ ]change|Scope[_ ]change|Goal[_ ]reframe|Conditions?[_ ]change|Get[_ ]fact[_ ]first|Keep[_ ]open|Underlying[_ ]goal|Internal[_ ]change|Ownership[_ ]change|Financing[_ ]change)\)/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const askAllowed = audit.triage !== 'CRISIS' && !distressMarkerDetected && (contextSufficiency === 'LOW' || contextSufficiency === 'MEDIUM');
    const cleanQuestion = askAllowed ? (typeof out.question === 'string' ? out.question.trim() : '') : '';
    // The client renders and stores only `reply`, so the follow-up question must be part of it.
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const crisisNow = audit.triage === 'CRISIS' || distressMarkerDetected;
    const crisisBlock = crisisNow
      ? `\n\n---\nIf you are in immediate danger, contact local emergency services or a person near you right now.\n${SUPPORT_CONTACTS.map((c) => `${c.label}: ${c.value}`).join('\n')}`
      : '';
    const visibleReply =
      (cleanQuestion && !norm(cleanReply).includes(norm(cleanQuestion))
        ? `${cleanReply}\n\n${cleanQuestion}`
        : cleanReply) + crisisBlock;
    ok(res, {
      reply: visibleReply,
      question: cleanQuestion,
      contextSufficiency,
      triage: audit.triage,
      gain: audit.gain,
      options: Array.isArray(out.options) ? out.options.filter((x: any) => typeof x === 'string').slice(0, 8) : [],
      newOptions: getOptionStrings(out.newOptions).slice(0, 5),
      newOptionTypes: Array.isArray(out.newOptionTypes) ? out.newOptionTypes.map((x: any) => String(x)).slice(0, 5) : [],
      nextStep: typeof out.nextStep === 'string' ? out.nextStep.trim() : '',
      factsToCheck: Array.isArray(out.factsToCheck) ? out.factsToCheck.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
      state: out.state && typeof out.state === 'object' ? out.state : undefined,
    }, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'conversation error');
  }
});

// --- POST /api/neutralize ---
app.post('/api/neutralize', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, thirdPerson } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'Fill the Decision field', 'PRECONDITION');
    const input = JSON.stringify(brief);
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');
    const prompt = `Step neutralize. User Brief:
${input}
${thirdPerson ? 'Rewrite in third person (“A person is facing…”).' : ''}
Return JSON: { "items": [ { "id": "n1", "original": "...", "kind": "KEEP"|"NEUTRALIZE"|"INTERPRETATION", "neutralQuestion": "..." } ], "thirdPersonText": "..." }
Rules: keep facts, constraints, values, fears, and inconvenient details in full. Neutralize statements that the decision is already made (“I decided”), demonstrations of certainty (“I know for sure”), first-person phrasing that pushes toward agreement, and requests to confirm the user is right: turn each into a neutral question such as “what data would support and what would refute this?”. Interpretations about other people or the future → question “what is observable?”. Do not add your own claims.`;
    const { data, meta } = await generate(prompt, input, 'light', 'neutralize');
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'neutralize error');
  }
});

// --- POST /api/radar ---
app.post('/api/radar', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, neutralization } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No Brief', 'PRECONDITION');
    if (!neutralization?.length) return fail(res, 400, 'Neutralization not confirmed', 'PRECONDITION');
    const input = JSON.stringify({ brief, neutralization });
    const prompt = `Step radar. Confirmed input:
${input}
Return JSON with six categories:
{
  "decisionProfile": { "deadline", "acceptableOutcome", "costOfError", "reversibility" },
  "facts": [{"id","text","source"}],
  "assumptions": [...],
  "interpretations": [...],
  "values": [...],
  "unknowns": [{
    "id","question","whyChangesDecision","owner","howToFindOut",
    "effort":"MINUTES"|"DAYS"|"WEEKS",
    "impact":"HIGH"|"MEDIUM"|"LOW",
    "branchIfA":{"answer","leadsTo"},
    "branchIfB":{"answer","leadsTo"},
    "critical": true|false,
    "source"
  }],
  "needsExternalCheck": [{"id","text","source"}]
}
decisionProfile values come only from the user's input, otherwise "unknown".
Unknowns: 1–7, only if branches lead to different options or reframing. Order by value of information (impact on the decision versus cost of learning). No numbers not from input. No forced “minimum 2 HIGH”.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'radar');
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'radar error');
  }
});

// --- POST /api/understand ---
// One model call for neutralization + epistemic radar. This keeps the first AI step
// useful without spending two Gemini requests back-to-back.
app.post('/api/understand', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    const input = JSON.stringify({ brief });
    const prompt = `Step understand. Analyze the user's decision in one pass.
Return JSON:
{
  "triage": "PROCEED"|"LIGHT"|"VALUES_ONLY"|"CRISIS",
  "triageNote": "one short sentence if triage is not PROCEED, otherwise empty",
  "decisionProfile": {
    "deadline": "from user input or \"unknown\"",
    "acceptableOutcome": "from user input or \"unknown\"",
    "costOfError": "from user input or \"unknown\"",
    "reversibility": "from user input or \"unknown\""
  },
  "neutralization": {
    "items": [{ "id", "original", "kind":"KEEP"|"NEUTRALIZE"|"INTERPRETATION", "neutralQuestion":"..." }]
  },
  "radar": {
    "facts": [{"id","text","source"}],
    "assumptions": [{"id","text","source"}],
    "interpretations": [{"id","text","source"}],
    "values": [{"id","text","source"}],
    "unknowns": [{
      "id","question","whyChangesDecision","owner","howToFindOut",
      "effort":"MINUTES"|"DAYS"|"WEEKS",
      "impact":"HIGH"|"MEDIUM"|"LOW",
      "branchIfA":{"answer","leadsTo"},
      "branchIfB":{"answer","leadsTo"},
      "critical":true|false,"source"
    }],
    "needsExternalCheck": [{"id","text","source"}]
  }
}
Rules:
- Triage first. CRISIS = acute distress: return empty lists and a humane triageNote saying a real person or specialist is needed now and the decision can wait if possible. VALUES_ONLY = nothing to discover, only values. LIGHT = cheap and easily reversible. Otherwise PROCEED.
- Preserve user facts, constraints, values, and fears. Separate facts from assumptions and interpretations. Statements of certainty or of an already-made decision are assumptions to test.
- Do not accept the user's framing as complete: if the listed options rest on an assumption that is not a fact, put that assumption in "assumptions".
- Unknowns are critical only when different answers could materially change the realistic option space or reframe the decision. Order unknowns by value of information: highest impact on the decision and cheapest to learn first. Ranking unknowns is allowed.
- Default owner is "You". Do not invent facts, numbers, prices, deadlines, or probabilities. Everything must come from this user's own situation, not from typical topics.`;
    const { data, meta } = await generate(prompt, input, 'light', 'understand');
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'understand error');
  }
});

// --- POST /api/knowledge-map ---
app.post('/api/knowledge-map', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, radar } = req.body || {};
    // D-11: critical unknowns must have answer/owner
    const criticals = (radar?.unknowns || []).filter((u: any) => u.critical && !u.discarded);
    const bad = criticals.filter(
      (u: any) =>
        (!u.answer && u.status !== 'USER_UNKNOWN' && u.status !== 'ACCEPTED_UNCERTAINTY') ||
        !u.owner
    );
    if (bad.length) {
      return fail(
        res,
        400,
        `Critical unknowns without answer/owner: ${bad.map((u: any) => u.id || u.question).join(', ')}`,
        'PRECONDITION'
      );
    }
    const input = JSON.stringify({ brief, radar });
    const prompt = `Step knowledge-map. Data:
${input}
Return JSON: { "known":[], "unknown":[], "critical":[], "quickToGet":[], "needsIndependentCheck":[] }
Only from already known data, no new facts.`;
    const { data, meta } = await generate(prompt, input, 'light', 'knowledge-map');
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'knowledge-map error');
  }
});

// --- POST /api/expand ---
// One model call produces the knowledge map and the formal 3–5 option expansion.
app.post('/api/expand', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, radar, myOptions } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    if (!radar) return fail(res, 400, 'Radar not confirmed', 'PRECONDITION');
    const input = JSON.stringify({ brief, radar, myOptions });
    const prompt = `Step expand. First make a concise knowledge map from the confirmed radar, then expand the decision space.
Return JSON: {
  "knowledgeMap": { "known":[], "unknown":[], "critical":[], "quickToGet":[], "needsIndependentCheck":[] },
  "options": [ {
    "id","title","description","kind":"HYBRID_OR_PILOT"|"REVERSIBLE_STEP"|"GET_FACT_FIRST"|"OTHER",
    "keyAssumption","exitCost","cheapestTest","door":"ONE_WAY"|"TWO_WAY","linkedUnknownIds":[]
  } ]
}
The formal expansion must contain exactly 3–5 additional options beyond the user's apparent A/B framing. It must include at least one HYBRID_OR_PILOT, one REVERSIBLE_STEP, and one GET_FACT_FIRST.
Each option must change the shape of the decision (timing, sequence, a temporary test, a reversible commitment, splitting the decision, scale or scope, changing conditions instead of choosing another object, reaching the goal another way, reframing the goal, keeping several futures open, or first obtaining the deciding fact). Another item on the same axis as the user's options does not count. Every option must be a concrete action this user could really take, derived only from their own facts; in "description" say what it changes in the original dilemma. Count the exit cost honestly: a pilot that costs almost as much as the full step is not a pilot. No ranking, recommendation, winner, score, or invented facts/numbers.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'expand');
    const out = data as any;
    const opts = out?.options || [];
    if (opts.length < 3 || opts.length > 5) {
      return fail(res, 500, `Expected 3–5 options, got ${opts.length}`, 'SCHEMA');
    }
    const kinds = new Set(opts.map((o: any) => o.kind));
    for (const k of ['HYBRID_OR_PILOT', 'REVERSIBLE_STEP', 'GET_FACT_FIRST']) {
      if (!kinds.has(k)) return fail(res, 500, `Missing required kind: ${k}`, 'SCHEMA');
    }
    ok(res, out, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'expand error');
  }
});

// --- POST /api/redteam-pair ---
// Attack two substantive options in one model call, symmetrically.
app.post('/api/redteam-pair', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, firstOption, secondOption, radar, knowledgeMap } = req.body || {};
    if (!firstOption?.id || !secondOption?.id) return fail(res, 400, 'Two options are required', 'PRECONDITION');
    const input = JSON.stringify({ brief, firstOption, secondOption, radar, knowledgeMap });
    const prompt = `Step attack. Challenge both options symmetrically: first the option the user leans toward (the first option if no leaning is visible), then the opposite one, with the same depth.
Return JSON: { "rounds": [
  { "role":"PREFERRED", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] },
  { "role":"OPPOSITE", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] }
] }
3–5 strongest objections per option. Objections must be concrete and tied to this user's facts; generic objections that fit any plan are not allowed. Mark an objection TESTABLE only if a specific observation could confirm or refute it. Do not soften critique, do not favor either option. No invented facts or numbers.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'redteam-pair');
    const rounds = Array.isArray((data as any)?.rounds) ? (data as any).rounds : [];
    if (rounds.length !== 2) return fail(res, 500, 'Expected two red-team rounds', 'SCHEMA');
    ok(res, { rounds }, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'redteam error');
  }
});

// --- POST /api/redteam ---
app.post('/api/redteam', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, option, role } = req.body || {};
    if (!option?.id) return fail(res, 400, 'No option selected', 'PRECONDITION');
    const input = JSON.stringify({ brief, option, role });
    const prompt = `Step redteam (${role || 'PREFERRED'}). Option:
${input}
Return JSON: { "objections": [ {
  "id","argument","hiddenAssumption","failureMode",
  "whatMustBeTrueForCritiqueToBeWeak",
  "verifiability":"TESTABLE"|"SPECULATION"
} ] }
3–5 strong objections tied to this user's facts; no generic objections. Do not soften. No recommendation to choose an option.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'redteam');
    ok(res, data, meta);
  } catch (e: any) {
    if (e?.code === 'GEMINI_QUOTA') return fail(res, 429, e.message, e.code);
    if (e?.code === 'GEMINI_RATE_LIMIT') return fail(res, 429, e.message, e.code);
    fail(res, 500, e.message || 'redteam error');
  }
});

// --- POST /api/premortem ---
app.post('/api/premortem', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, preferredOption, redTeamRounds } = req.body || {};
    if (!redTeamRounds || redTeamRounds.length < 2) {
      return fail(res, 400, 'Need both red team rounds', 'PRECONDITION');
    }
    const unanswered = redTeamRounds.flatMap((r: any) =>
      (r.objections || []).filter((o: any) => !o.response?.verdict || !o.response?.reason)
    );
    if (unanswered.length) {
      return fail(res, 400, 'Every objection needs accepted/rejected + reason', 'PRECONDITION');
    }
    const input = JSON.stringify({ brief, preferredOption, redTeamRounds });
    const prompt = `Step premortem. Data:
${input}
Return JSON: {
  "horizonMonths": <horizon months number 12–24, no invented dates>,
  "causes": [{"text","verifiability":"TESTABLE"|"SPECULATION","verificationAction"}],
  "narrative": "one narrative ≤120 words",
  "whatDistinguishesFromForecast": "...",
  "hypothesisCandidates": [{"id","text","verifiability"}]
}
Horizon 12–24 months (a number in this range is allowed as a method parameter). Imagine the chosen path has failed and work backward. 5–8 most plausible causes tied to this user's facts; separate what can be tested from speculation. One narrative marked “Scenario, not a forecast”. Up to 5 hypothesis candidates, ordered by how much the decision depends on them; the user chooses which 1–3 are critical. No probabilities and no monetary valuation of inaction. Numbers only from user input or the horizon parameter.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'premortem');
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'premortem error');
  }
});

// --- POST /api/experiment-draft ---
app.post('/api/experiment-draft', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, hypotheses } = req.body || {};
    const selected = (hypotheses || []).filter((h: any) => h.selectedByUser);
    if (selected.length < 1 || selected.length > 3) {
      return fail(res, 400, 'Select 1–3 testable hypotheses', 'PRECONDITION');
    }
    const input = JSON.stringify({ brief, hypotheses: selected });
    const prompt = `Step experiment-draft. Hypotheses:
${input}
Return JSON: { "drafts": [ {
  "hypothesisId","whyCritical","test","metric","deadlineWords",
  "threshold_questions":["..."],
  "intermediateOutcomeQuestion":"what will you do if the result lands between the success and stop thresholds?",
  "whoCountsQuestion":"which participants, customers or observations count and which do not (define before the test, e.g. exclude the close circle)",
  "decisionAfterEachOutcome":{"success":"...","failure":"...","inBetween":"..."},
  "killCriteriaQuestions":["measurable stop condition the user must set before starting, and what to do next after stopping"],
  "costOfErrorAndReversibility":"how costly and how reversible this test is",
  "validity_threats":[{"threat","protection"}],
  "reviewPointQuestions":["what will be compared with the forecast at 30, 90, 180 days"],
  "shareWithThirdParty":"one sentence: give a copy of thresholds and stop conditions to a trusted person before the test starts",
  "ifSuccessHint","ifFailureHint"
} ] }
Prefer the test with the highest value of information at the lowest cost and risk. The test must be able to change the decision. No numeric thresholds: the human sets thresholds and records their own forecast and confidence. Everything derived from this user's own facts.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'experiment-draft');
    // Ensure no numeric thresholds in schema sense
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'experiment-draft error');
  }
});

// --- POST /api/forecast-wording ---
app.post('/api/forecast-wording', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { experiment } = req.body || {};
    if (!experiment) return fail(res, 400, 'No experiment card', 'PRECONDITION');
    const input = JSON.stringify(experiment);
    const prompt = `Step forecast-wording. Card:
${input}
Return JSON: { "wordings": { "30": "...", "90": "...", "180": "..." } }
Only observable criteria: what exactly will count as having come true, and by which observation. No percentages or confidence: the human records their own probability and confidence. If there are no grounds for a criterion at some horizon, say so instead of inventing one.`;
    const { data, meta } = await generate(prompt, input, 'light', 'forecast-wording');
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'forecast-wording error');
  }
});

// --- POST /api/synthesis ---
app.post('/api/synthesis', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const body = req.body || {};
    const input = JSON.stringify(body);
    const prompt = `Step synthesis. Full decision context:
${input}
Return JSON: {
  "paragraphs": ["paragraph1","paragraph2","paragraph3","paragraph4","paragraph5"],
  "derived_numbers": [{"value": <number>,"formula":"calc: operands from input","operands":[<from input>]}],
  "open_gaps": [],
  "needs_external_check": []
}
Exactly 5 paragraphs of coherent prose, 250–350 words total. Cover, in this order: (1) what is known; (2) what is not known; (3) which facts or test results could change the decision; (4) the next step with the most information for the least cost, and how the path branches on the user's own thresholds; (5) what requires external verification, the main risks, and where this analysis could be wrong or sensitive to wording or to the model.
Do not choose for the user: one conditional path, not a verdict “choose X”. The user takes and records the decision. Numbers only from input or with a formula. No “best”, “optimal”, or probabilities.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'synthesis');
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'synthesis error');
  }
});

// --- POST /api/review ---
app.post('/api/review', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { journalEntry, brief } = req.body || {};
    const input = JSON.stringify({ journalEntry, brief });
    const prompt = `Step review. Journal entry:
${input}
Return JSON: { "questions": [
  {"area":"DATA","question":"..."},
  {"area":"ASSUMPTION","question":"..."},
  {"area":"REASONING","question":"..."},
  {"area":"EXECUTION","question":"..."},
  {"area":"LUCK","question":"..."}
] }
Questions only, no diagnosis and no changing the forecast. Tie each question to this entry's own forecast and fact. Chance (area "LUCK") is the last question and is asked only after the other four: if the same decision were taken many times with the same data, would the outcome differ often enough to count as chance?`;
    const { data, meta } = await generate(prompt, input, 'light', 'review');
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'review error');
  }
});

// Legacy endpoints return 410
app.post('/api/analyze-full', (_req, res) => {
  fail(res, 410, 'Monolithic analysis removed. Use step endpoints.', 'GONE');
});
app.post('/api/radar-legacy', (_req, res) => {
  fail(res, 410, 'Legacy radar. Use /api/neutralize → /api/radar.', 'GONE');
});

// EVPI is client-side only (G-09) — optional server echo for tests
app.post('/api/evpi', (req, res) => {
  const { p, G, L, c } = req.body || {};
  const pNorm = p > 1 ? p / 100 : p;
  const evOpen = pNorm * G - (1 - pNorm) * L;
  const bestNoInfo = Math.max(evOpen, 0);
  const evPerfect = pNorm * G;
  const evpiVal = evPerfect - bestNoInfo;
  ok(res, { evOpen, bestNoInfo, evPerfect, evpi: evpiVal, testCost: c }, { model: 'local', fallback: false, durationMs: 0, stage: 'evpi' });
});

async function start() {
  if (NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }
  app.listen(PORT, () => {
    console.log(`Bifurcation Engine v${APP_VERSION} on :${PORT} (${NODE_ENV})`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
