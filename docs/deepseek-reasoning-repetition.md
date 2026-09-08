# DeepSeek reasoning short-line loops

## Symptom and evidence

The CLI can remain in thinking mode while its omitted-line counter reaches tens
of thousands and its tail cycles through phrases such as `好。`, `好，我发送。`
and `（发送）`.

`formatThinking()` derives that counter from the accumulated reasoning text; it
does not increment it on redraw. The API parser appends each
`delta.reasoning_content` once. Repeated phrases have also been observed in
persisted reasoning, independently of the terminal display. This is consistent
with upstream reasoning degeneration, but screenshots and completed transcripts
alone cannot distinguish model behavior, triggering context, or a replaying
transport. A healthy short API request does not rule out a long-context failure.

The runtime had a separate, reproducible containment gap:

- The display deduplicator only checks identical chunks of at least 50
  characters. Token-sized repeated phrases bypass it.
- Every incoming reasoning event resets the idle timer and counts toward
  progress-based extensions of the stream deadline.
- The reasoning-spiral hook runs before a later turn, so it cannot stop a loop
  inside the current response.

## Runtime behavior

For the existing `deepseek` provider, the SSE parser now checks thinking-only
output before delivering it to the UI. It uses a bounded window of 128 non-empty
lines. If at least 90% of that window consists of at most four repeated short
phrases (no more than 32 UTF-16 code units per line), it raises
`ReasoningRepetitionError` and cancels the unfinished response.

The check is independent of SSE chunk boundaries, works on character-sized
deltas and the final event without a trailing newline, and does not depend on a
particular model ID. A model added through `/connect` under DeepSeek gets the same
protection. It applies before answer text or tool-call progress; it does not
truncate normal long reasoning, alter answer text, or deduplicate the reasoning
that a successful tool turn must echo back to the provider.

The failure is non-retryable and non-reconnectable. Partial reasoning from the
failed response is not committed as a successful assistant turn or automatically
injected into another attempt. The CLI suggests a fresh conversation or a model
switch. The last displayed thinking remains partial output, not a completed
answer. Aborted-attempt diagnostics continue to report received characters and
elapsed time; final provider usage may be unavailable after cancellation.

This is a conservative containment heuristic, not a repair of model weights or
context. Deliberate reasoning with the same extreme short-line distribution can
trigger it. Loops without newline boundaries, or with many long/varied phrases,
are outside its scope; existing time and output limits still apply.

## Diagnosing another occurrence

1. Record the installed CLI version, provider/base URL, model ID, and whether a
   gateway or proxy is involved. Do not share API keys.
2. Compare an innocuous fresh request through the official endpoint with the
   CLI. Then compare equivalent task/context and thinking settings. Changing
   both task and model provides correlation, not a controlled A/B experiment.
3. When raw evidence is needed, set `RIVET_DEBUG_RAW_SSE` to a private local file
   path for one reproduction. The file includes model output and tool arguments;
   inspect and redact it before sharing. Unset the variable after the run.
4. Concatenate the captured `choices[0].delta.reasoning_content` fields in order
   and compare counts with the CLI transcript. Repeated raw frames rule out a
   rendering-only explanation; only CLI-side repetition points to client wiring.

Do not repeatedly continue a conversation already dominated by degenerate
reasoning. Start a fresh conversation with a concise task summary or use a stable
model. Merely hiding duplicate lines does not stop server-side generation.

## Verification

`src/api/__tests__/reasoning-repetition.test.ts` covers synthetic short-line
loops, character chunking, healthy long reasoning, occasional repetition, other
providers, tool progress, residual SSE data, malformed JSON, consumer error
propagation, same-event reasoning/content preservation, and no automatic retry.
The fixtures contain no user transcript or credentials and require no API access.

Reference: [DeepSeek thinking-mode protocol](https://api-docs.deepseek.com/guides/thinking_mode/).
