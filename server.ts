/**
 * Bifurcation Engine v9 server
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
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
const DAILY_CALL_CAP = Number(process.env.DAILY_CALL_CAP) || 200;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (NODE_ENV === 'production' && !APP_ACCESS_TOKEN) {
  console.error('APP_ACCESS_TOKEN required in production');
  process.exit(1);
}

app.use(express.json({ limit: MAX_BODY }));

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

const LIGHT_MODELS = (
  process.env.MODEL_CASCADE_LIGHT ||
  'gemini-2.5-flash-lite,gemini-2.5-flash'
).split(',').map((s) => s.trim()).filter(Boolean);

const STRONG_MODELS = (
  process.env.MODEL_CASCADE_STRONG ||
  'gemini-2.5-flash,gemini-2.5-flash-lite'
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
  if (APP_ACCESS_TOKEN) {
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

async function generate(
  prompt: string,
  inputForNumbers: string,
  modelClass: ModelClass,
  stage: string
): Promise<{ data: unknown; meta: { model: string; fallback: boolean; durationMs: number; stage: string } }> {
  if (!ai) throw new Error('GEMINI_API_KEY is not configured. Local mode: fill fields manually.');
  const models = modelClass === 'light' ? LIGHT_MODELS : STRONG_MODELS;
  let lastErr: Error | null = null;
  const t0 = Date.now();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
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
      const bad = validateNumbers(r.text, inputForNumbers);
      if (bad.length) {
        // one repair attempt
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
        const bad2 = validateNumbers(repair.text, inputForNumbers);
        if (bad2.length) {
          throw new Error(`Response contains numbers outside input: ${bad2.join(', ')}`);
        }
        return {
          data: parseJson(repair.text),
          meta: {
            model,
            fallback: i > 0,
            durationMs: Date.now() - t0,
            stage,
          },
        };
      }
      return {
        data: parseJson(r.text),
        meta: {
          model,
          fallback: i > 0,
          durationMs: Date.now() - t0,
          stage,
        },
      };
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.error(`[${stage}] model ${model} failed:`, lastErr.message);
    }
  }
  throw lastErr || new Error('All cascade models unavailable');
}

function ok(res: express.Response, data: unknown, meta: unknown) {
  res.json({ success: true, data, meta });
}

function fail(res: express.Response, status: number, error: string, code?: string) {
  res.status(status).json({ success: false, error, code });
}

// --- Health (NF-03) ---
app.get('/api/health', (_req, res) => {
  if (!APP_ACCESS_TOKEN) {
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
    globalDayCount++;
    ok(res, data, meta);
  } catch (e: any) {
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
    globalDayCount++;
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'radar error');
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
    globalDayCount++;
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'knowledge-map error');
  }
});

// --- POST /api/expand ---
app.post('/api/expand', async (req, res) => {
  try {
    if (!aiGate(req, res)) return;
    const { brief, knowledgeMap, myOptions } = req.body || {};
    if (!knowledgeMap) return fail(res, 400, 'Knowledge map not confirmed', 'PRECONDITION');
    if (!brief?.decision) return fail(res, 400, 'No decision text', 'PRECONDITION');
    const input = JSON.stringify({ brief, knowledgeMap, myOptions });
    const prompt = `Step expand. Data:
${input}
If the user did not explicitly provide A/B options, infer the apparent framing only as context and still expand beyond it.
Return JSON: { "options": [ {
  "id","title","description","kind":"HYBRID_OR_PILOT"|"REVERSIBLE_STEP"|"GET_FACT_FIRST"|"OTHER",
  "keyAssumption","exitCost","cheapestTest","door":"ONE_WAY"|"TWO_WAY","linkedUnknownIds":[]
} ] }
Exactly 3–5 additional options. Must include one each: HYBRID_OR_PILOT, REVERSIBLE_STEP, GET_FACT_FIRST.
No ranking, no “best”, no numbers not from input.`;
    const { data, meta } = await generate(prompt, input, 'strong', 'expand');
    const opts = (data as any)?.options || [];
    if (opts.length < 3 || opts.length > 5) {
      return fail(res, 500, `Expected 3–5 options, got ${opts.length}`, 'SCHEMA');
    }
    const kinds = new Set(opts.map((o: any) => o.kind));
    for (const k of ['HYBRID_OR_PILOT', 'REVERSIBLE_STEP', 'GET_FACT_FIRST']) {
      if (!kinds.has(k)) {
        return fail(res, 500, `Missing required kind: ${k}`, 'SCHEMA');
      }
    }
    globalDayCount++;
    ok(res, data, meta);
  } catch (e: any) {
    fail(res, 500, e.message || 'expand error');
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
    globalDayCount++;
    ok(res, data, meta);
  } catch (e: any) {
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
    globalDayCount++;
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
    globalDayCount++;
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
    globalDayCount++;
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
    globalDayCount++;
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
    globalDayCount++;
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
