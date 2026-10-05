# Bifurcation Engine v13

Decision cockpit implementing the **Before You Choose** method (Bifurcation Engine).

International edition: English interface, USD examples, no regional localization. People can write to the agent in any language: it answers in the language it is written to, and the interface can be translated with the browser.

The default screen is a conversation. The method (radar, expansion, critique, small tests, return) is kept by the agent and stays invisible; the step-by-step protocol is available in expert mode.

## Method loops

**UNDERSTAND → EXPAND → ATTACK → VERIFY → LEARN**

- Epistemic radar (6 categories) → knowledge map  
- User options + 3–5 from the model (hybrid / reversible / get-fact)  
- Symmetric red team + pre-mortem + 1–3 hypotheses  
- Experiment Card with lock-in, EVPI (article example = 40), forecast only from the human  
- Decision is written only by the human  

## Stack

React + TypeScript + Vite, Express, Gemini API, localStorage, zod.

## Run

```bash
cp .env.example .env
# set GEMINI_API_KEY and optionally APP_ACCESS_TOKEN
npm install
npm run dev
```

Production:

```bash
npm run build
npm start
```

Checks:

```bash
npm run lint:copy
npm run test:core
npm run check
npm run test:virtual   # real server.ts against a scripted fake Gemini (no key, no network)
```

## Crisis support

Default contacts are international (IASP, 988 where applicable). Replace in `src/config/support.ts` for a specific region.

Distress detection works in two layers: a multilingual marker list (`src/config/support.ts`, checked on every message in the conversation and on the server) and the model's own crisis triage in any language. When either fires, the server appends the contacts to the reply and the client shows them.

## Version

13.0.0 - one version number everywhere (the local-storage data schema keeps its own number, `SCHEMA_VERSION`).
Highlights: conversation-first agent with invisible method discipline, memory of the next step and expectations between visits, multilingual crisis safety, soft quality checks instead of hard errors. See `CHANGELOG_AGENT_BEHAVIOR.md`.
