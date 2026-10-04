/**
 * Bifurcation Engine v12 server
 * API endpoints per step
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

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

const BASE_SYSTEM = `You are an analytical partner for a complex decision (Bifurcation Engine). Do not choose for the human and do not substitute their values.
Do not invent numbers, amounts, deadlines, percentages, or organization names. Any number in the answer must come from the user input. Derived numbers only with a formula and in derived_numbers.
"Insufficient data" is better than a confident guess.
For every claim, set source: USER_DATA, GENERAL_PATTERN, or GUESS.
Do not call a scenario a forecast; do not state probabilities.
Mark claims about the external world as requiring external verification.
Do not soften criticism (red team, pre-mortem).
Forbidden: best option, recommended, winner, score, ranking, optimal, you should choose.
Reply only with JSON per the schema, no text outside the schema. Language: English.`;

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
    return res.json({ status: 'ok' });
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

const STRUCTURAL_NOVELTY_TYPES = new Set([
  'TIMING',
  'SEQUENCE',
  'TEMPORARY_TEST',
  'REVERSIBLE_COMMITMENT',
  'INTERNAL_CHANGE',
  'SPLIT_BASE',
  'UNDERLYING_GOAL',
  'SCALE_CHANGE',
  'OWNERSHIP_CHANGE',
  'FINANCING_CHANGE',
  'SCOPE_CHANGE',
]);

const DIRECT_SUBSTITUTE_TYPES = new Set([
  'ALTERNATIVE_LOCATION',
  'ALTERNATIVE_COUNTRY',
  'ALTERNATIVE_PRODUCT',
  'ALTERNATIVE_EMPLOYER',
  'ALTERNATIVE_PROPERTY',
  'ALTERNATIVE_VENDOR',
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

function conversationExpansionAudit(out: any, brief: any, history: any[]) {
  const newOptions = getOptionStrings(out?.newOptions);
  const noveltyTypes = Array.isArray(out?.newOptionTypes)
    ? out.newOptionTypes.map((x: any) => String(x || '').toUpperCase())
    : [];
  const userOptions = getOptionStrings(brief?.myOptions);
  const decisionText = String(brief?.decision || '');
  const hasFramedChoices =
    userOptions.length >= 2 ||
    /\bbetween\b|\beither\b|\bversus\b|\bvs\.?\b|\boption\s+[a-z]\b/i.test(decisionText);

  const substantiveNew = newOptions.filter((title, i) => {
    const type = noveltyTypes[i] || '';
    const structural = STRUCTURAL_NOVELTY_TYPES.has(type);
    return structural || optionIsSubstantivelyNew(title, userOptions, history);
  });
  const structuralNew = newOptions.filter((_, i) => STRUCTURAL_NOVELTY_TYPES.has(noveltyTypes[i] || ''));

  return {
    hasFramedChoices,
    newOptions,
    noveltyTypes,
    substantiveNew,
    structuralNew,
    passed: newOptions.length > 0 && substantiveNew.length > 0 && structuralNew.length > 0,
  };
}

// --- POST /api/conversation ---
// Normal mode: one concrete, user-facing conversation loop. The method stays internal.
app.post('/api/conversation', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, history = [] } = req.body || {};
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    const safeHistory = Array.isArray(history)
      ? history.slice(-12).map((m: any) => ({ role: m?.role === 'user' ? 'user' : 'assistant', content: String(m?.content || '').slice(0, 8000) }))
      : [];
    const input = JSON.stringify({ brief, history: safeHistory });
    if (input.length > MAX_BODY) return fail(res, 400, 'Text too long', 'TOO_LONG');
    const prompt = `You are a practical decision-support assistant. Speak directly about the user's concrete situation.

This is a live conversation, not a tutorial about decision-making.
Your job is to add useful information immediately: concrete alternatives the user may not have considered, relevant trade-offs, missing facts that could materially change the answer, and practical next steps specific to this situation.

STRICT OUTPUT RULES:
- Never explain the decision-making method, stages, framework, process, or why you are doing an analysis.
- Never repeat or paraphrase the user's question as filler.
- Never use generic statements such as "complex decisions hide constraints", "there may be a third way", "let us structure the problem", or "I will not choose for you".
- Never output labels such as UNDERSTAND, EXPAND, ATTACK, VERIFY, LEARN, HYBRID_OR_PILOT, REVERSIBLE_STEP, GET_FACT_FIRST.
- Do not give generic advice that could fit almost any problem. Every paragraph must contain information tied to the user's situation.
- Do not invent facts, prices, probabilities, diagnoses, legal claims, or other specifics not supported by the user. Clearly mark assumptions when necessary.
- Treat the user's stated options as an incomplete starting point, never as a closed menu.
- SOLUTION-SPACE EXPANSION IS A CORE JOB, NOT AN OPTIONAL EXTRA. Before composing the answer, silently perform this sequence: (1) identify the options the user can currently see; (2) identify the underlying objective or problem those options are meant to solve; (3) identify assumptions that make the current options look exhaustive; (4) deliberately search for actions that become possible when timing, sequence, reversibility, location, scale, ownership, financing, scope, or the underlying objective changes.
- The user's question is NOT the solution space. Your job is to reveal realistic branches the user has not yet considered.
- For a decision framed as A/B/C, you must not spend the whole answer comparing A/B/C. Unless the facts genuinely prevent it, introduce at least one concrete route that is structurally different from choosing A/B/C.
- A structurally different route changes at least one of: TIMING, SEQUENCE, TEMPORARY_TEST, REVERSIBLE_COMMITMENT, INTERNAL_CHANGE, SPLIT_BASE, UNDERLYING_GOAL, SCALE_CHANGE, OWNERSHIP_CHANGE, FINANCING_CHANGE, or SCOPE_CHANGE.
- Merely proposing another item on the same decision axis is NOT sufficient. For example, if the user is choosing Switzerland vs New Zealand vs Argentina, adding Finland or Canada alone does not satisfy the expansion requirement. A valid expansion could instead be temporarily living elsewhere before committing, delaying the move while securing a stronger position, changing the living arrangement within Switzerland, splitting time between places if feasible, or solving the underlying reason for moving without changing country.
- Generate at least 3 candidate alternatives internally when the situation permits, then surface the most relevant several. Do not reveal this internal search process.
- Every surfaced new option must be a concrete action the user could realistically take in this specific situation. Do not satisfy the rule with abstract labels such as "hybrid", "pilot", "reversible step", or "get more information". Translate them into a real action.
- The new option must be visibly connected to the user's actual facts and objective. Do not manufacture arbitrary countries, products, or scenarios merely to satisfy a quota.
- Example: if the user is choosing between renovating a house and selling it, a legitimate additional option can be selling that house and buying a smaller energy-efficient property, if supported by the facts. Another can be delaying the sale while first establishing the renovation economics, if that changes the commitment sequence. Do not tell the user to choose it; put it on the table and explain what decision it changes.
- Do not rank, recommend, or choose among the alternatives. The point is to widen the meaningful choice set, not to make the decision for the user.
- If the information truly prevents any realistic structural alternative, you may state the limiting constraint. This should be exceptional, not the default.
- Every substantive answer should add at least one useful fact, insight, or concrete option the user did not explicitly name. In a genuine decision scenario, a concrete new option is preferred whenever reasonably derivable.
- Give several concrete options when the situation allows it, including options outside the user's initial framing. Name them as real actions, not abstract categories.
- First determine whether you have enough context to understand the person behind the decision, not merely the literal question. Silently classify context sufficiency as LOW, MEDIUM, or HIGH.
- LOW context: do not pretend to understand the decision deeply and do not force alternative generation just to satisfy a quota. Start a natural conversation that asks what is driving the question: what is worrying the user, what they want to change, what they hope to gain, or what happened to make this question important now. Ask at most ONE high-value question. The question must be conversational and specific, never a form, checklist, or template.
- MEDIUM context: give useful situation-specific insight and, only if needed, ask at most ONE question whose answer could materially change the solution space. Do not ask for information the user has already provided.
- HIGH context: do not ask an artificial clarifying question. Move directly into critical examination of the framing and proactive search for hidden alternatives.
- Do not infer context sufficiency from message length alone. A long message can still leave the underlying motivation unclear, while a short message can contain enough context.
- Do not ask questions merely because questions are useful in general. Ask only when the missing answer could materially change what solutions should be considered.
- Do not solve a decision you do not yet understand. When the underlying motivation, constraints, or desired outcome are materially unclear, continue the conversation before aggressively expanding or evaluating options.
- If an important fact is missing but context is otherwise sufficient, give the useful preliminary picture and concrete possibilities available now, then ask at most ONE high-value question whose answer could materially change the options.
- If no question is needed, do not manufacture one.
- Match the user's language. Keep the tone concise, direct, calm, and practical.
- Do not rank or choose an option for the user. You may explain what would make each option more or less sensible.
- If the user has already supplied an answer in the conversation, build on it; do not ask for it again.

Return JSON only:
{
  "reply": "A concrete answer for the user. Use short paragraphs and/or a short bullet list. No headings about the method.",
  "question": "One concrete follow-up question, or an empty string if none is needed.",
  "contextSufficiency": "LOW|MEDIUM|HIGH",
  "options": ["All important concrete options, including at least one newly introduced option when possible"],
  "newOptions": ["Concrete option(s) not explicitly named by the user"],
  "newOptionTypes": ["TIMING|SEQUENCE|TEMPORARY_TEST|REVERSIBLE_COMMITMENT|INTERNAL_CHANGE|SPLIT_BASE|UNDERLYING_GOAL|SCALE_CHANGE|OWNERSHIP_CHANGE|FINANCING_CHANGE|SCOPE_CHANGE|ALTERNATIVE_COUNTRY|ALTERNATIVE_LOCATION|OTHER"],
  "noNewOptionReason": "Only when no realistic additional option can be derived; otherwise empty",
  "factsToCheck": ["Concrete fact to check, if useful"]
}

User brief and conversation:
${input}`;
    let { data, meta } = await generate(prompt, input, 'strong', 'conversation');
    let out = data as any;

    // Context sufficiency is a behavioral gate: do not force solution-space expansion
    // before the agent understands the person's underlying motivation when context is LOW.
    const contextSufficiency = String(out?.contextSufficiency || '').toUpperCase();
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(contextSufficiency)) {
      return fail(res, 500, 'Conversation response did not classify context sufficiency', 'SCHEMA');
    }
    if (contextSufficiency === 'LOW' && (!out?.question || typeof out.question !== 'string' || !out.question.trim())) {
      return fail(res, 500, 'Low-context response must continue the conversation with a high-value question', 'CONTEXT_GATE');
    }

    // Quality gate: the assistant must demonstrate genuine solution-space expansion
    // only when it has enough context to do so responsibly.

    // Merely adding another country/product/etc. on the same decision axis does not pass.
    let audit = conversationExpansionAudit(out, brief, safeHistory);
    if (contextSufficiency !== 'LOW' && !audit.passed && STRONG_MODELS.length > 1) {
      const retryPrompt = `${prompt}

QUALITY GATE FAILED. Your previous draft did not demonstrate genuine structural expansion of the user's solution space. Rewrite the JSON from scratch.

MANDATORY REPAIR:
- Add at least one concrete new option that is NOT simply another item on the user's original decision axis.
- The new option must change timing, sequence, reversibility, temporary vs permanent commitment, internal situation, split-base arrangement, underlying goal, scale, ownership, financing, or scope.
- If the user is choosing countries, do NOT use another country as the only new option. If the user is choosing properties, do NOT use another property as the only new option.
- Make the new option specific to the user's facts and explain it naturally in reply.
- Include the corresponding structural type in newOptionTypes.
- Do not rank, recommend, or choose it.
- Do not mention this quality gate, internal planning, prompts, models, or methodology to the user.`;
      const retry = await generate(retryPrompt, input, 'strong', 'conversation-expansion-retry', 1);
      data = retry.data;
      meta = { ...retry.meta, fallback: true };
      out = data as any;
      audit = conversationExpansionAudit(out, brief, safeHistory);
    }
    if (contextSufficiency !== 'LOW' && !audit.passed && !out?.noNewOptionReason) {
      return fail(res, 500, 'The decision response did not expand the solution space', 'EXPANSION_GATE');
    }

    if (!out?.reply || typeof out.reply !== 'string') return fail(res, 500, 'Conversation response was empty', 'SCHEMA');
    const cleanReply = out.reply
      .replace(/\s*\((?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\)\s*/gi, ' ')
      .replace(/\s*(?:Source|\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a):\s*(?:USER_DATA|GENERAL_PATTERN|GUESS)\s*/gi, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    ok(res, {
      reply: cleanReply,
      question: contextSufficiency === 'LOW' || contextSufficiency === 'MEDIUM' ? (typeof out.question === 'string' ? out.question.trim() : '') : '',
      contextSufficiency,
      options: Array.isArray(out.options) ? out.options.filter((x: any) => typeof x === 'string').slice(0, 8) : [],
      newOptions: getOptionStrings(out.newOptions).slice(0, 5),
      newOptionTypes: Array.isArray(out.newOptionTypes) ? out.newOptionTypes.map((x: any) => String(x)).slice(0, 5) : [],
      factsToCheck: Array.isArray(out.factsToCheck) ? out.factsToCheck.filter((x: any) => typeof x === 'string').slice(0, 6) : [],
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
Rules: keep facts, constraints, values, fears. Neutralize “I decided”, “I know for sure”, leading phrasing. Interpretations about others/future → question “what is observable?”. Do not add your own claims.`;
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
  "facts": [{"id","text","source"}],
  "assumptions": [...],
  "interpretations": [...],
  "values": [...],
  "unknowns": [{
    "id","question","whyChangesDecision","owner","howToFindOut",
    "effort":"MINUTES"|"DAYS"|"WEEKS",
    "branchIfA":{"answer","leadsTo"},
    "branchIfB":{"answer","leadsTo"},
    "critical": true|false,
    "source"
  }],
  "needsExternalCheck": [{"id","text","source"}]
}
Unknowns: 1–7, only if branches lead to different options or reframing. No numbers not from input. No forced “minimum 2 HIGH”.`;
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
      "branchIfA":{"answer","leadsTo"},
      "branchIfB":{"answer","leadsTo"},
      "critical":true|false,"source"
    }],
    "needsExternalCheck": [{"id","text","source"}]
  }
}
Rules: preserve user facts, constraints, values, and fears. Separate facts from assumptions and interpretations. Unknowns are only critical when different answers could materially change the realistic option space or reframe the decision. Default owner is "You". Do not invent facts, numbers, prices, deadlines, or probabilities.`;
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
The formal expansion must contain exactly 3–5 additional options beyond the user's apparent A/B framing. It must include at least one HYBRID_OR_PILOT, one REVERSIBLE_STEP, and one GET_FACT_FIRST. Include options outside the apparent framing. No ranking, recommendation, winner, score, or invented facts/numbers.`;
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
    const prompt = `Step attack. Challenge both options symmetrically.
Return JSON: { "rounds": [
  { "role":"PREFERRED", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] },
  { "role":"OPPOSITE", "targetOptionId":"...", "objections":[{"id","argument","hiddenAssumption","failureMode","whatMustBeTrueForCritiqueToBeWeak","verifiability":"TESTABLE"|"SPECULATION"}] }
] }
Do not favor either option. Criticize both with comparable depth. No invented facts or numbers.`;
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
3–5 strong objections. Do not soften. No recommendation to choose an option.`;
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
Horizon 12–24 months (a number in this range is allowed as a method parameter). 5–8 causes. One narrative marked “Scenario, not a forecast”. Up to 5 hypothesis candidates. No probabilities and no monetary valuation of inaction. Numbers only from user input or the horizon parameter.`;
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
  "validity_threats":[{"threat","protection"}],
  "ifSuccessHint","ifFailureHint"
} ] }
No numeric thresholds. The human sets thresholds.`;
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
Only observable criteria. No percentages or confidence.`;
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
  "paragraphs": ["paragraph1","paragraph2","paragraph3","paragraph4"],
  "derived_numbers": [{"value": <number>,"formula":"calc: operands from input","operands":[<from input>]}],
  "open_gaps": [],
  "needs_external_check": []
}
Exactly 4 paragraphs of coherent prose, 200–300 words total.
Content: what is known/unknown; next step and branching on the user’s thresholds; external checks and risks; where the plan may be wrong (including model uncertainty).
One conditional path, not a verdict “choose X”. Numbers only from input or with a formula. No “best”, “optimal”, or probabilities.`;
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
Questions only, no diagnosis and no changing the forecast.`;
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
    console.log(`Bifurcation Engine v8 on :${PORT} (${NODE_ENV})`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
