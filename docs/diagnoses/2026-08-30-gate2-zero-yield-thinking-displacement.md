# Gate 2 zero-yield baseline cases: thinking displacement, not model silence

## Bug

Eight Gate 2 baseline observations across two runs terminated at exactly `8192`
output tokens with an empty `rawCandidate`, `finishReason: length`, and
`candidateError: "Gate 2 benchmark contract: manifest must be strict JSON"`. They
were read as the baseline model producing nothing, and baseline scaffold was
scored `0/5` on that basis.

    r7  gate2-local-vulcan-target-discovery-r7-20260828  baseline  6 of 30 at 8192
        refactor-cart-money-module, refactor-schema-task-view,
        scaffold-cart-discount, scaffold-greeting-command,
        scaffold-lantern-json-output, scaffold-parser-cli
    v1  gate2-local-vulcan-code-routing-20260828         baseline  2 of 30 at 8192
        scaffold-cart-discount, scaffold-lantern-json-output

    routed arm, both runs: 0 at 8192; max output 5585 (r7) and 3540 (v1)

Re-derive with:

    python3 - <<'PY'
    import json, io, os, glob
    for root in sorted(glob.glob("docs/evals/artifacts/*")):
        for arm in ("baseline", "routed"):
            for f in sorted(glob.glob(os.path.join(root, arm, "*.json"))):
                r = json.load(io.open(f))
                u = (r.get("observation") or {}).get("usage") or {}
                if u.get("outputTokens") == 8192:
                    print(arm, os.path.basename(f), len(r.get("rawCandidate") or ""), r.get("finishReason"))
    PY

## Root cause (partial — see Limits)

The records store `rawCandidate: generated.text`
(`scripts/gate2-live-benchmark.mjs:644`). An empty string therefore means the
gateway returned empty **content**, not that the model was idle:
`scaffold-cart-discount` recorded `latencyMs: 145543` and `outputTokens: 8192`
for that empty string.

At the time of both runs, Vulcan could neither request nor return thinking.
`_OllamaMessage` was `ConfigDict(extra="ignore")` with `role`/`content`/
`tool_calls` only, so Ollama's `thinking` field was discarded in transit, and no
field on `ChatCompletionRequest` could carry a `think` directive. Any tokens the
model spent reasoning were billed in `eval_count`, invisible to the harness, and
absent from `content`.

Live measurement against the exact baseline model (`ornith-1.5:35b`), local
Ollama, `temperature: 0`, `num_predict: 8192`, shows thinking displacing content
severely once a schema is in force — and the displacement is what the harness
recorded as emptiness:

    no schema, trivial prompt          think unset   eval   18   thinking   52   content    2
    no schema, plan prompt             think unset   eval  381   thinking 1211   content  602
    no schema, hard refactor prompt    think unset   eval 1068   thinking 1737   content 3143
    no schema, hard refactor prompt    think=false   eval  687   thinking    0   content 3201

    with schema, scaffold prompt       think unset   eval 1436   thinking 5364   content  208
    with schema, scaffold prompt       think=false   eval 1457   thinking    0   content 7380

The last pair is the finding: **the same billed token count yields 208 characters
of content with thinking on and 7380 with it off — a 35x displacement** — and the
thinking half was unobservable through Vulcan.

A separate probe confirms constrained decoding can reach the exact signature: a
schema the prompt cannot satisfy (three CVE identifiers with no basis in the
input) ran to `eval_count: 8192`, `done_reason: length`.

## Limits — what this does NOT establish

The exact failure was **not reproduced end to end**. No probe here produced 8192
tokens *and* empty content simultaneously; the schema+thinking arm stopped
cleanly at 1436. These probes carry a fraction of the real input — the Gate 2
records show `inputTokens: 972` with a digest-bound instruction policy and
retrieved repository context that the probes omit. Thinking displacement is
measured; that it is the *sole* cause of the eight cases is inferred and unproven.

An earlier pass in this session refuted the thinking hypothesis outright on the
strength of the three no-schema rows above. That refutation was wrong: it omitted
the schema, which is the operative variable. Recorded here because the shape of
the error matters more than the conclusion — the hypothesis was tested against
something adjacent to the real conditions.

## Consequences

1. Baseline scaffold `0/5` is **censored, not measured** — four of the six r7
   cases are scaffold. See the amendment in
   [ADR 0067](../adr/0067-gate2-target-discovery-profile.md).
2. The frozen `maxTokens: 8192` is pinned as a content budget but is really a
   combined thinking-plus-content budget with an unobservable split, digest-bound
   into the profile across all 60 observations.
3. Any rerun before the gateway can surface thinking will produce the same
   uninterpretable evidence: an empty string and a contract error, with the
   model's actual work discarded in transit.

## Fix status

Vulcan `c6223a6` adds a tri-state `think` on the request path and surfaces
`thinking` on the response path, so a rerun can both suppress the reasoning and,
when it is left on, observe what it consumed. That change is **on Vulcan's `main`
and not deployed**: mickey's `~/deploy/vulcan` still runs `a5ffd95`. Until it is
deployed, the instrument that would close this diagnosis is not in the path the
benchmark uses.

## Verification

- Records: `docs/evals/artifacts/*/baseline/*.json`, the re-derivation above.
- Harness retention: `scripts/gate2-live-benchmark.mjs:644`.
- Live probes: local Ollama `/api/chat`, `ornith-1.5:35b`, `temperature: 0`,
  `num_predict: 8192`, run on flow 2026-08-30.
