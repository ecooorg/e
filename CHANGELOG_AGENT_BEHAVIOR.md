# Agent behavior and model routing changes

## v13 (versions unified; earlier 8/10/11/12 labels retired)
- Conversation is the default; the method is kept by the agent. Entry offers four optional starting intents (think out loud / argue against my plan / prepare for a conversation / what to find out first) as plain chips, not forms.
- Memory without accounts: the client stores the agent's `state` and `nextStep` per decision and sends them back; "Noted for next time" shows the step. A visit after 1+ day tells the agent (`returningAfterDays`) to start from what happened.
- Safety: multilingual distress markers checked on every message (client) and on the server; the model also triages crisis in any language; on either signal the server appends international contacts to the reply and suppresses questions.
- Prompt: one warm human sentence when feelings are expressed (no therapy language); facts and values are separated instead of the all-or-nothing values-only exit; convergence to one small step after about four messages, with an optional short note for oneself or a trusted person; natural "other seat" / "prepare the conversation with the other person" / expectations without percentages / stopping rule in plain words.
- `translate="no"` and `dir="auto"` on conversation text so browser translation does not rewrite what people wrote and right-to-left languages render correctly.
- `npm run check` is green: core tests now import the real modules (run with tsx) and test the real number-validation contract (percent-only).
- Not in v13 (expert mode, planned separately): journal 30/90/180, confidence input 0-100 only, replacing alert()/prompt(), record versions with hash.

## Agent behavior (current)
- The conversational agent is an analytical engine, not a chat assistant: it uses model strengths (structuring, hidden assumptions, option space, critique, calculation, test design) and does not imitate human experience or values.
- Core question of every reply: which next fact, check or experiment would most change the decision, and how to get it cheaply.
- Triage first (CRISIS / VALUES_ONLY / LIGHT / PROCEED). CRISIS stops analysis and points to a real person.
- The user's options are treated as what they currently see, not the whole space. New branches must change the *shape* of the decision (timing, sequence, test, reversibility, split, scale, scope, goal, conditions, get-fact-first, keep-open), never just one more item on the same axis.
- Expansion is not mandatory: a reply may instead add a reframing, a hidden assumption, a contradiction, a decisive unknown, a cheap test or a calculation.
- LOW context: no expansion; say what is understood, show the fork, ask one question. MEDIUM: analysis + at most one question. HIGH: no question.
- The follow-up question is appended to `reply` by the server (the client renders only `reply`).
- Quality check is soft: one retry on the reserve model; if it still fails the person gets the answer anyway (no 500 from quality gates).
- The agent never chooses, ranks or recommends among options/values; it may name the most informative next step. No invented numbers/percentages; thresholds are set by the human.
- Reframing alone is not an answer: after it the agent must still give a working structure for the question asked (for "when should I act" questions: a ladder of signals - watch / prepare / test / decide - with outside facts separated from personal thresholds the person sets).
- Concreteness test: any phrase the person could answer with "what exactly would I do?" must be expanded into an action, who is involved, cost in kind and reversibility. Empty phrases ("prepare groundwork", "build flexibility") are not allowed.
- If the agent catches itself writing "for your case / in your region" about something it does not know, that circumstance is the decisive unknown and must be asked.
- No invented durations/amounts/counts; general claims are tendencies worth verifying; no beliefs attributed to the person that they did not state; no restating the question or sweeping opener.
- Server strips leaked method labels such as "(Split-base)" or "(Sequence)" from replies as a safety net.
- Prompt contains no subject-matter examples. Subject examples belong in test cases (tests/virtual), not in the prompt.

## Model routing
- Strong primary: `gemini-3.8-flash`
- Strong reserve: `gemini-3.1-pro-preview`
- Light: `gemini-3.5-flash-lite`
- At most one reserve-model fallback is attempted for a request.
- Per-model 429/rate-limit errors may trigger one reserve attempt.
- Transient 5xx/service-unavailable/timeout errors may trigger one reserve attempt.
- Daily/provider quota exhaustion does not cascade across models.
- The application also counts actual model calls against `DAILY_CALL_CAP`.
- The conversation quality-gate retry explicitly starts on the reserve strong model, so it does not repeat the primary model unnecessarily.
