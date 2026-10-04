# Bifurcation Engine v11

Decision cockpit implementing the **Before You Choose** method (Bifurcation Engine).

International edition: English UI and prompts, USD examples, no regional localization.

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
```

## Crisis support

Default contacts are international (IASP, 988 where applicable). Replace in `src/config/support.ts` for a specific region.

## Version

11.0.0 — full internationalization (English), USD; no regional contacts, currency, or copy.
