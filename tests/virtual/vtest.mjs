import fs from 'node:fs';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:3111';
const DIR = process.env.STUB_DIR || '/tmp/stub';
const results = [];

function reset(script) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(DIR + '/script.json', JSON.stringify(script));
  fs.writeFileSync(DIR + '/calls.jsonl', '');
}
function calls() {
  const t = fs.readFileSync(DIR + '/calls.jsonl', 'utf8').trim();
  return t ? t.split('\n').map((l) => JSON.parse(l)) : [];
}
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n     ', e.message.split('\n')[0]); }
}
const J = (o) => ({ json: o });

// canned conversation drafts ------------------------------------------------
const good = (over = {}) => J({
  reply: 'The question hides a different fork: the real issue is X, not A versus B. One cheap check decides which branch matters.',
  question: '', contextSufficiency: 'HIGH', triage: 'PROCEED',
  gain: ['REFRAMED_QUESTION', 'DECISIVE_UNKNOWN'],
  options: ['A', 'B', 'Try A for a limited period before committing'],
  newOptions: ['Try A for a limited period before committing'], newOptionTypes: ['TEST_OR_PILOT'],
  noNewOptionReason: '', nextStep: 'Ask the provider for written terms', factsToCheck: ['terms'],
  derived_numbers: [], state: { facts: ['f'], assumptions: [], unknowns: ['u'], options: [], hypotheses: [] }, ...over,
});
const sameAxis = () => good({ gain: ['NEW_BRANCH'], newOptions: ['Option C'], newOptionTypes: ['OTHER'], nextStep: '' });
const brief = { decision: 'I need to decide between A and B before the end of the quarter.' };

// ---------------------------------------------------------------- tests
await test('health endpoint', async () => {
  const r = await fetch(BASE + '/api/health'); assert.equal((await r.json()).status, 'ok');
});

await test('conversation: missing decision -> 400, no model call', async () => {
  reset([]); const r = await post('/api/conversation', { brief: {} });
  assert.equal(r.status, 400); assert.equal(calls().length, 0);
});

await test('conversation: HIGH context, good answer -> 1 call, fields present, no question', async () => {
  reset([good()]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); const d = r.body.data;
  assert.ok(d.reply.length > 20); assert.equal(d.question, ''); assert.equal(d.triage, 'PROCEED');
  assert.deepEqual(d.gain, ['REFRAMED_QUESTION', 'DECISIVE_UNKNOWN']); assert.equal(d.nextStep, 'Ask the provider for written terms');
  assert.equal(calls().length, 1); assert.equal(calls()[0].model, 'gemini-3.8-flash');
});

await test('conversation: prompt + system instruction content (domain-free, language, schema)', async () => {
  reset([good()]);
  await post('/api/conversation', { brief, history: [] });
  const c = calls()[0];
  for (const w of ['Switzerland', 'Zealand', 'Argentina', 'Finland', 'Canada', 'renovat', 'coffee', 'ALTERNATIVE_COUNTRY'])
    assert.ok(!c.contents.includes(w) && !c.system.includes(w), 'domain anchor leaked: ' + w);
  assert.ok(!c.system.includes('Language: English'));
  assert.ok(c.system.includes('language of the user'));
  assert.ok(c.contents.includes('Which next fact, check or experiment would most change this decision'));
  assert.ok(c.contents.includes('I need to decide between A and B'), 'user input interpolated');
  assert.ok(!c.contents.includes('${') && !c.contents.includes('undefined'));
  assert.equal(c.mime, 'application/json');
  console.log('      prompt size:', c.contents.length, 'chars (~' + Math.round(c.contents.length / 4) + ' tokens), system:', c.system.length, 'chars');
});

await test('conversation: LOW context -> question is APPENDED to visible reply (client shows only reply)', async () => {
  reset([good({ reply: 'I see a fork already, but cannot tell which side it is on yet.', question: 'What exactly pushed this question up now?', contextSufficiency: 'LOW', gain: ['DECISIVE_UNKNOWN'], newOptions: [], newOptionTypes: [] })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200); assert.ok(r.body.data.reply.endsWith('What exactly pushed this question up now?'), r.body.data.reply);
  assert.equal(calls().length, 1, 'LOW is exempt from the expansion check');
});

await test('conversation: question already inside reply is not duplicated', async () => {
  const q = 'Which of the two costs more to undo?';
  reset([good({ reply: 'Analysis here. ' + q, question: q, contextSufficiency: 'MEDIUM' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.body.data.reply.split(q).length - 1, 1);
});

await test('conversation: HIGH context drops stray question', async () => {
  reset([good({ question: 'Anything else?' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.body.data.question, ''); assert.ok(!r.body.data.reply.includes('Anything else?'));
});

await test('conversation: same-axis "new option" fails audit -> retry on reserve model -> retry answer used', async () => {
  reset([J(sameAxis().json), good({ reply: 'RETRY ANSWER with a structural branch.' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200); assert.ok(r.body.data.reply.startsWith('RETRY ANSWER'));
  const c = calls(); assert.equal(c.length, 2); assert.equal(c[1].model, 'gemini-3.1-pro-preview');
  assert.ok(c[1].contents.includes('QUALITY CHECK FAILED')); assert.equal(r.body.meta.fallback, true);
});

await test('conversation: audit fails twice -> user STILL gets an answer (no EXPANSION_GATE 500)', async () => {
  reset([J(sameAxis().json), J(sameAxis().json)]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.data.reply.length > 0);
});

await test('conversation: retry call crashes (503) -> first draft returned, 200', async () => {
  reset([J(sameAxis().json), { error: { status: 503, message: 'service unavailable' } }]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200); assert.ok(r.body.data.reply.length > 0);
});

await test('conversation: CRISIS triage -> no retry, question suppressed', async () => {
  reset([good({ triage: 'CRISIS', contextSufficiency: 'LOW', reply: 'This moment calls for a real person. The decision can wait.', question: 'Tell me more about your options?', gain: [], newOptions: [], newOptionTypes: [], nextStep: '' })]);
  const r = await post('/api/conversation', { brief: { decision: 'I cannot go on' }, history: [] });
  assert.equal(r.status, 200); assert.equal(r.body.data.triage, 'CRISIS'); assert.equal(r.body.data.question, '');
  assert.ok(!r.body.data.reply.includes('Tell me more')); assert.equal(calls().length, 1);
});

await test('conversation: LIGHT triage passes without expansion', async () => {
  reset([good({ triage: 'LIGHT', gain: [], newOptions: [], newOptionTypes: [], nextStep: 'Just try it for a week.' })]);
  const r = await post('/api/conversation', { brief: { decision: 'Which pen to buy' }, history: [] });
  assert.equal(r.status, 200); assert.equal(calls().length, 2 - 1);
});

await test('conversation: invalid contextSufficiency no longer 500s (defaults to MEDIUM)', async () => {
  reset([good({ contextSufficiency: 'WHATEVER' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200); assert.equal(r.body.data.contextSufficiency, 'MEDIUM');
});

await test('conversation: invalid JSON from model -> 500 with message (existing behaviour kept)', async () => {
  reset([{ text: 'not json at all' }]);
  const r = await post('/api/conversation', { brief, history: [] }); assert.equal(r.status, 500);
});

await test('conversation: empty reply -> 500 SCHEMA', async () => {
  reset([good({ reply: '' }), good({ reply: '' })]);
  const r = await post('/api/conversation', { brief, history: [] }); assert.equal(r.status, 500); assert.equal(r.body.code, 'SCHEMA');
});

await test('conversation: client-format history (role/content/at) + state passthrough reach the prompt', async () => {
  reset([good()]);
  const history = [{ role: 'assistant', content: 'FIRST REPLY TEXT', at: 1 }, { role: 'user', content: 'MY ANSWER 42', at: 2 }];
  await post('/api/conversation', { brief, history, state: { facts: ['STATE-FACT-XYZ'] } });
  const p = calls()[0].contents; assert.ok(p.includes('FIRST REPLY TEXT') && p.includes('MY ANSWER 42') && p.includes('STATE-FACT-XYZ'));
});

await test('conversation: history longer than 12 is trimmed to last 12', async () => {
  reset([good()]);
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'MSG-' + i }));
  await post('/api/conversation', { brief, history });
  const p = calls()[0].contents; assert.ok(!p.includes('MSG-7"') && p.includes('MSG-19'));
});

await test('conversation: "(Source: GUESS)" tags stripped from reply', async () => {
  reset([good({ reply: 'Claim one (Source: GUESS). Claim two Source: USER_DATA done.' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.ok(!/USER_DATA|GUESS/.test(r.body.data.reply), r.body.data.reply);
});

await test('conversation: leaked method labels like (Split-base)/(Sequence) are stripped from reply', async () => {
  reset([good({ reply: 'Keep the current place but rent elsewhere (Split-base). Get permission early (Sequence). Real words (in brackets) stay.' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.ok(!/Split-base|\(Sequence\)/.test(r.body.data.reply), r.body.data.reply);
  assert.ok(r.body.data.reply.includes('(in brackets)'));
});

await test('conversation: prompt carries the new rules (ladder, concreteness, hidden decisive unknown, no attribution)', async () => {
  reset([good()]);
  await post('/api/conversation', { brief, history: [] });
  const p = calls()[0].contents;
  for (const k of ['WHEN THE PERSON DOES NOT KNOW WHEN TO ACT', 'ladder of signals', 'what exactly would I do', 'that circumstance is the decisive unknown', 'Do not attribute to the person', 'No invented durations', 'working structure for the question they asked', 'never put method labels'])
    assert.ok(p.includes(k), 'missing in prompt: ' + k);
});

await test('v13: health reports version 13.0.0', async () => {
  const r = await (await fetch(BASE + '/api/health')).json(); assert.equal(r.version, '13.0.0');
});

await test('v13: context flags (intent, userTurns, returningAfterDays) reach the prompt; invalid intent dropped', async () => {
  reset([good()]);
  const history = [{ role: 'user', content: 'a', at: 1 }, { role: 'assistant', content: 'b', at: 2 }, { role: 'user', content: 'c', at: 3 }];
  await post('/api/conversation', { brief, history, intent: 'ARGUE_AGAINST', returningAfterDays: 3, state: { expectations: ['EXPECT-XYZ'] } });
  let p = calls()[0].contents;
  assert.ok(p.includes('"intent":"ARGUE_AGAINST"') && p.includes('"userTurns":2') && p.includes('"returningAfterDays":3') && p.includes('EXPECT-XYZ'));
  reset([good()]); await post('/api/conversation', { brief, history, intent: 'DROP TABLE', returningAfterDays: 0 });
  p = calls()[0].contents; assert.ok(!p.includes('DROP TABLE') && !p.includes('"returningAfterDays"'));
});

await test('v13: prompt carries warmth, fact/value split, convergence, natural ways of looking, flags', async () => {
  reset([good()]);
  await post('/api/conversation', { brief, history: [] });
  const p = calls()[0].contents;
  for (const k of ['one short, plain, human sentence', 'Use VALUES_ONLY only when there is nothing factual at all', 'NATURAL WAYS OF LOOKING', 'CONTEXT FLAGS', 'A conversation that never closes is a failure', 'second channel of checking', 'Expectations without percentages', '"expectations": []'])
    assert.ok(p.includes(k), 'missing in prompt: ' + k);
});

await test('v13 safety: Russian distress phrase -> contacts appended even if model says PROCEED; question suppressed; flag in prompt', async () => {
  reset([good({ reply: 'Analysis text.', question: 'What else?', contextSufficiency: 'MEDIUM' })]);
  const r = await post('/api/conversation', { brief: { decision: 'Я не хочу жить, не знаю что делать' }, history: [] });
  assert.equal(r.status, 200); const d = r.body.data;
  assert.ok(d.reply.includes('988') && d.reply.includes('iasp.info') && d.reply.includes('emergency'), d.reply);
  assert.equal(d.question, ''); assert.ok(!d.reply.includes('What else?'));
  assert.ok(calls()[0].contents.includes('"distressMarkerDetected":true'));
});

await test('v13 safety: model CRISIS triage (no marker, other language) -> contacts appended', async () => {
  reset([good({ triage: 'CRISIS', contextSufficiency: 'LOW', reply: 'Nimm dir Zeit. Sprich bitte mit einem Menschen.', question: '', gain: [], newOptions: [], newOptionTypes: [], nextStep: '' })]);
  const r = await post('/api/conversation', { brief: { decision: 'Alles ist zu viel, ich kann nicht mehr' }, history: [] });
  assert.ok(r.body.data.reply.includes('988') && r.body.data.reply.startsWith('Nimm dir Zeit'));
});

await test('v13 safety: ordinary reply has NO contacts block', async () => {
  reset([good()]); const r = await post('/api/conversation', { brief, history: [] });
  assert.ok(!r.body.data.reply.includes('988') && !r.body.data.reply.includes('iasp'));
});

await test('numbers: invented percentage -> repair call -> accepted when repaired', async () => {
  reset([good({ reply: 'About 73% of such cases fail.' }), good({ reply: 'Such cases often fail.' })]);
  const r = await post('/api/conversation', { brief, history: [] });
  assert.equal(r.status, 200); assert.equal(calls().length, 2); assert.ok(calls()[1].contents.includes('PREVIOUS RESPONSE contained numbers'));
});

await test('numbers: calculation with derived_numbers + formula passes validator', async () => {
  reset([good({ reply: 'On your numbers the break-even share is 62.5% of capacity.', gain: ['CALCULATION'], derived_numbers: [{ value: 62.5, formula: '50 / 80', operands: [50, 80] }] })]);
  const r = await post('/api/conversation', { brief: { decision: 'Fixed costs 50, capacity 80' }, history: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(calls().length, 1);
});

await test('errors: quota -> 429 GEMINI_QUOTA; rate-limit on primary falls to reserve', async () => {
  reset([{ error: { status: 429, message: 'Quota exceeded for daily limit' } }]);
  let r = await post('/api/conversation', { brief, history: [] }); assert.equal(r.status, 429); assert.equal(r.body.code, 'GEMINI_QUOTA');
  reset([{ error: { status: 429, message: 'too many requests' } }, good()]);
  r = await post('/api/conversation', { brief, history: [] }); assert.equal(r.status, 200); assert.equal(calls()[1].model, 'gemini-3.1-pro-preview');
});

// ---------------------------------------------------------------- step endpoints
const radar = { facts: [], assumptions: [], interpretations: [], values: [], unknowns: [], needsExternalCheck: [] };
await test('understand: prompt has triage/decisionProfile/impact; additive fields pass through', async () => {
  reset([J({ triage: 'PROCEED', triageNote: '', decisionProfile: { deadline: 'unknown' }, neutralization: { items: [] }, radar })]);
  const r = await post('/api/understand', { brief }); assert.equal(r.status, 200); assert.equal(r.body.data.triage, 'PROCEED');
  const p = calls()[0].contents; assert.ok(p.includes('decisionProfile') && p.includes('"impact"') && p.includes('CRISIS'));
  assert.equal(calls()[0].model, 'gemini-3.5-flash-lite');
});
await test('neutralize / radar prompts built', async () => {
  reset([J({ items: [], thirdPersonText: '' })]); let r = await post('/api/neutralize', { brief, thirdPerson: true }); assert.equal(r.status, 200);
  assert.ok(calls()[0].contents.includes('third person') && calls()[0].contents.includes('confirm'));
  reset([J(radar)]); r = await post('/api/radar', { brief, neutralization: [{ id: 'n1' }] }); assert.equal(r.status, 200); assert.ok(calls()[0].contents.includes('decisionProfile'));
});
await test('expand: valid 3 options passes; 2 options -> 500; missing kind -> 500', async () => {
  const o = (id, kind) => ({ id, title: id, description: 'd', kind, keyAssumption: 'k', exitCost: 'e', cheapestTest: 't', door: 'TWO_WAY', linkedUnknownIds: [] });
  const km = { known: [], unknown: [], critical: [], quickToGet: [], needsIndependentCheck: [] };
  reset([J({ knowledgeMap: km, options: [o('c', 'HYBRID_OR_PILOT'), o('d', 'REVERSIBLE_STEP'), o('e', 'GET_FACT_FIRST')] })]);
  let r = await post('/api/expand', { brief, radar, myOptions: [] }); assert.equal(r.status, 200);
  assert.ok(calls()[0].contents.includes('Another item on the same axis'));
  reset([J({ knowledgeMap: km, options: [o('c', 'HYBRID_OR_PILOT'), o('d', 'REVERSIBLE_STEP')] })]);
  r = await post('/api/expand', { brief, radar }); assert.equal(r.status, 500);
  reset([J({ knowledgeMap: km, options: [o('c', 'OTHER'), o('d', 'REVERSIBLE_STEP'), o('e', 'GET_FACT_FIRST')] })]);
  r = await post('/api/expand', { brief, radar }); assert.equal(r.status, 500);
});
await test('redteam-pair: two rounds ok, otherwise 500; redteam single', async () => {
  const round = (role) => ({ role, targetOptionId: 'x', objections: [] });
  reset([J({ rounds: [round('PREFERRED'), round('OPPOSITE')] })]);
  let r = await post('/api/redteam-pair', { brief, firstOption: { id: 'a' }, secondOption: { id: 'b' } }); assert.equal(r.status, 200);
  assert.ok(calls()[0].contents.includes('first the option the user leans toward'));
  reset([J({ rounds: [round('PREFERRED')] })]); r = await post('/api/redteam-pair', { brief, firstOption: { id: 'a' }, secondOption: { id: 'b' } }); assert.equal(r.status, 500);
  reset([J({ objections: [] })]); r = await post('/api/redteam', { brief, option: { id: 'a' }, role: 'OPPOSITE' }); assert.equal(r.status, 200);
});
await test('premortem: preconditions + horizon number 18 allowed', async () => {
  let r = await post('/api/premortem', { brief, redTeamRounds: [] }); assert.equal(r.status, 400);
  const rounds = [{ objections: [{ response: { verdict: 'ACCEPTED', reason: 'r' } }] }, { objections: [{ response: { verdict: 'REJECTED', reason: 'r' } }] }];
  reset([J({ horizonMonths: 18, causes: [], narrative: 'Scenario, not a forecast', whatDistinguishesFromForecast: '', hypothesisCandidates: [] })]);
  r = await post('/api/premortem', { brief, preferredOption: { id: 'a' }, redTeamRounds: rounds }); assert.equal(r.status, 200);
});
await test('experiment-draft: 1-3 hypotheses required; new card fields requested', async () => {
  let r = await post('/api/experiment-draft', { brief, hypotheses: [] }); assert.equal(r.status, 400);
  reset([J({ drafts: [] })]); r = await post('/api/experiment-draft', { brief, hypotheses: [{ id: 'h1', selectedByUser: true }] }); assert.equal(r.status, 200);
  const p = calls()[0].contents; for (const k of ['intermediateOutcomeQuestion', 'whoCountsQuestion', 'killCriteriaQuestions', 'shareWithThirdParty']) assert.ok(p.includes(k), k);
});
await test('forecast-wording, synthesis (5 paragraphs), review (LUCK last), evpi', async () => {
  reset([J({ wordings: { 30: 'a', 90: 'b', 180: 'c' } })]); let r = await post('/api/forecast-wording', { experiment: { id: 'e' } }); assert.equal(r.status, 200);
  reset([J({ paragraphs: ['1', '2', '3', '4', '5'], derived_numbers: [], open_gaps: [], needs_external_check: [] })]); r = await post('/api/synthesis', { brief }); assert.equal(r.status, 200);
  assert.ok(calls()[0].contents.includes('Exactly 5 paragraphs'));
  reset([J({ questions: [] })]); r = await post('/api/review', { journalEntry: {}, brief }); assert.equal(r.status, 200); assert.ok(calls()[0].contents.includes('last question'));
  r = await post('/api/evpi', { p: 0.4, G: 100, L: 150, c: 10 }); assert.equal(r.body.data.evpi, 40);
});
await test('legacy endpoints still 410', async () => {
  assert.equal((await post('/api/analyze-full', {})).status, 410);
});

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
