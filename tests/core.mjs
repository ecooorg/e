/**
 * Core tests: real modules from src/ (no mirrored copies).
 * Run: npm run test:core   (executes with tsx so .ts sources can be imported)
 */
import assert from 'node:assert/strict';
import { evpi, evpiRange } from '../src/core/evpi.ts';
import { brierScore } from '../src/core/brier.ts';
import { triage } from '../src/core/triage.ts';
import { validateNumbers, extractNums } from '../src/core/numberValidator.ts';
import { hasDistressMarker, findDistressInTexts, SUPPORT_CONTACTS } from '../src/config/support.ts';

// T1 EVPI
{
  const r = evpi(0.4, 100, 150);
  assert.equal(r.evOpen, -50);
  assert.equal(r.evpi, 40);
  const range = evpiRange(0.4, 100, 150);
  assert.ok(Math.abs(range.min - 30) < 1e-6);
  assert.ok(Math.abs(range.max - 50) < 1e-6);
  console.log('T1 EVPI OK');
}

// T2 Brier
{
  const r = brierScore([{ p: 0.7, outcome: 1 }, { p: 0.6, outcome: 0 }, { p: 0.8, outcome: 1 }]);
  assert.ok(Math.abs(r.score - 0.1633) < 0.001);
  assert.equal(r.n, 3);
  assert.ok(r.warning, 'small sample warning expected');
  console.log('T2 Brier OK');
}

// T4 Triage
{
  const a = (o) => ({ crisis: false, onlyValues: false, costly: false, hardToUndo: false, resolvableUnknowns: false, longHorizon: false, ...o });
  assert.equal(triage(a({ crisis: true, costly: true })), 'CRISIS_STOP');
  assert.equal(triage(a({ onlyValues: true })), 'VALUES_ONLY');
  assert.equal(triage(a({ costly: true, hardToUndo: true })), 'METHOD_JUSTIFIED');
  assert.equal(triage(a({ costly: true })), 'OVERKILL');
  assert.equal(triage(a()), 'OVERKILL');
  console.log('T4 Triage OK');
}

// T5 Number validation: the real contract is "percentages (and probabilities) must come from the user"
{
  assert.deepEqual(extractNums('about 73% and 5 clients'), ['73%']);
  assert.deepEqual(validateNumbers('Such cases fail in 73% of the time.', 'I decide between A and B'), ['73%']);
  assert.deepEqual(validateNumbers('You said 40%, so 40% it is.', 'I think it is 40%'), []);
  assert.deepEqual(validateNumbers('Your 18 000 budget covers 300 clients.', 'budget 18 000'), []); // bare numbers are not checked (by design)
  assert.deepEqual(validateNumbers('Break-even is 62.5%.', 'costs 50 of 80', ['62.5']), []); // derived with formula
  console.log('T5 Numbers OK');
}

// T6 Distress markers: multilingual, plus harmless text stays clean
{
  for (const t of ["I don't want to live", 'я не хочу жить', 'No quiero vivir así', 'je veux mourir', 'ich will sterben', 'quero morrer', '死にたい', 'أريد أن أموت', 'Ich WILL STERBEN']) {
    assert.ok(hasDistressMarker(t), 'should flag: ' + t);
  }
  for (const t of ['Should I take the new job offer?', 'Стоит ли переезжать в другой город?', '¿Debo cambiar de trabajo?', '']) {
    assert.ok(!hasDistressMarker(t), 'should not flag: ' + t);
  }
  assert.equal(findDistressInTexts(['hello', 'I\u2019m thinking I want to die']), 'want to die');
  assert.ok(SUPPORT_CONTACTS.length >= 3);
  console.log('T6 Distress OK');
}

console.log('All core tests passed.');
