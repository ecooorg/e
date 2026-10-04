# Agent behavior and model routing changes

## Agent behavior
- The conversational agent must actively expand the user's solution space.
- If the user presents an A/B dilemma, A and B are treated as an incomplete starting point.
- The agent searches for concrete C/D/E alternatives that change mechanism, timing, scale, ownership, financing, scope, or the underlying objective.
- New alternatives must be real actions specific to the user's situation, not abstract method labels.
- The agent must not rank, recommend, or choose a final option for the user.
- The first substantive answer should add at least one useful new option or piece of information whenever this is realistically possible.
- A server-side quality gate retries once on the reserve strong model if a framed A/B problem receives no concrete new option.
- If no realistic new option exists, the model may explain the limiting constraint instead of inventing one.

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
