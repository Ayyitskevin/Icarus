# Gate 2 live rerun with reasoning suppressed — 2026-08-31

## Question

Gate 2's profile pins `maxTokens: 8192` and presents it as the budget for a model's
answer, but under Vulcan's Ollama path a reasoning model spends that same budget on
reasoning the gateway discards, with no observable split. Every prior observation —
including ADR 0066's and ADR 0067's — was therefore taken against a budget whose meaning
was not the one the profile stated.

[ADR 0070](../adr/0070-gate2-rerun-with-reasoning-suppressed.md) makes `maxTokens` a
content budget in fact by binding `think: false` into instruction-policy revision 9.
This run asks: **with the budget meaning what it says, what does Gate 2 measure?**

It does not answer whether reasoning helps, how much these models would emit, or what
the scores would be with reasoning enabled and an honest split.

## Result

Both arms completed in **12 minutes** (22:36–22:48), 30 cases each, on mickey against
Vulcan `c6223a6`.

| | baseline `code-fast` | routed `code` |
| --- | --- | --- |
| success | **2/30** | **12/30** |
| first-plan acceptance | 0.0667 | **0.60** |
| repair | 1 | 7 |
| explanation | 0 | 3 |
| security_review | 1 | 2 |
| refactor | **0** | **0** |
| scaffold | **0** | **0** |
| median cost per success | $0.000936 | $0.000732 |

Retrieval was identical across arms: macro recall `0.9917`, macro precision `0.8083`,
digest provenance coverage `1.0`, incorrect edits `0`.

**Both Gate 2 exit thresholds still fail.** 24/30 success and 0.80 first-plan
acceptance remain open, as they were after ADR 0067.

## The run is valid

Three properties had to hold before these numbers mean anything, and all three did:

- **Zero thinking characters across all 60 executions.** `think: false` reached every
  path; nothing silently dropped the field.
- **60/60 `finishReason: "stop"`.** No truncation, no timeouts, no protocol errors.
- **60/60 `usageBasis: "provider_reported"`.** Every token count is observed, none is a
  charged upper bound standing in for an unobserved one.

The zero-yield phenomenon is effectively gone: empty candidates fell from **8** to **1**
(`scaffold-lantern-json-output`, routed). The whole routed arm generated 9,998 output
tokens across 30 cases — fewer than the 8,192 a *single* zero-yield case burned on
2026-08-30 to return an empty string.

## What this refutes, including our own framing

The diagnosis called this **thinking displacement**: reasoning crowding out content
inside a shared budget. If that were the whole story, freeing the budget should have
raised scores.

It lowered them. Baseline fell 5/30 → 2/30 and routed fell 16/30 → 12/30.

The empty responses genuinely stopped — that part of the diagnosis holds, and it is why
`finishReason` is now `stop` everywhere. But the models now return well-formed, cheap,
**wrong** answers instead of expensive empty ones. **The reasoning was doing work, not
merely consuming budget.** "Displacement" described the accounting correctly and the
cause incompletely.

**These figures are not a before-and-after against ADR 0066/0067.** Those were measured
under a combined budget; the budget's meaning changed underneath both arms. A lower
number here is not a regression and must not be reported as one. This is a new baseline
under a stated budget.

## What the new evidence rules out

This is the first Gate 2 run carrying [ADR 0069](../adr/0069-retrieval-omission-is-evidence.md)
omission evidence, and it answers a question that was previously unanswerable:

**No case in either arm had a query match withheld by a retrieval ceiling** — zero
omitted matches across all 60 executions. The failures are therefore **not** explained by
truncated context. Before this run that could only be assumed; the artifacts now record
it. Two whole classes producing nothing (`refactor` 0/5, `scaffold` 0/5 in both arms) is
a capability or instruction result, not a context-starvation one.

## Limitations

- One profile, two models, one seed. No repetition, so nothing here separates model
  capability from run-to-run variance.
- `scaffold` and `refactor` are 0 in both arms; a floor of zero cannot show a routing
  difference, so the 6× success ratio rests on the three classes that scored.
- Cost figures are the profile's captured price table applied to observed tokens, not
  billed amounts (`actualBilledUsd` is null throughout).
- The single remaining empty candidate is uninvestigated.

## Verification

- Evidence: `.local/gate2-live-v2/03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169/`
  on mickey, execution-profile digest `03399661…`, manifest `0eca6348…`.
- Instruction policy revision 9, SHA `e6fb3111f6d2b9fe5d267117f705e1043ac7755fc14cca3ad499693094c6de57`,
  recorded in every case record.
- Commit `8640c9a`, Node 22.23.2, Vulcan `c6223a6`, models `qwen3.8:27b`
  (`22130167c4c2`) and `ornith-1.5:35b` (`9f3b89b25219`).
