# Evaluations

## Reliability rule

Icarus is not called reliable until representative tasks have measured evidence.
Unsupported scenarios are reported as unsupported, never converted to passes.

## Fixture contract

`fixtures/evals/manifest.json` names each repeatable scenario, its repository
fixture, task, expected outcome, required evidence, and minimum milestone.
`pnpm eval` validates every fixture, copies static cases into private temporary
workspaces, executes exact edit and policy assertions, runs the registered check
through the production no-network Docker sandbox, measures final bytes and
changed paths, verifies the source fixture stayed unchanged, runs named
test-backed scenarios, and writes
`.local/eval-report.json`. The report includes only measured evidence and
separates passed, failed, and unsupported counts.

Required scenario classes:

1. add a feature;
2. fix a bug;
3. refactor a module;
4. update a schema;
5. repair a failing test;
6. review a security issue;
7. explain an unfamiliar codebase;
8. reject a forbidden change;
9. recover from a failed tool/provider call;
10. resume an interrupted run.

The initial catalog has all ten classes. Milestone 1 executes five: one-file
replacement, schema/forbidden-path rejection, provider retry/resume, and
interrupted-operation accounting. Five broader classes remain explicitly
unsupported. Docker containment and rollback/restore are release-gate
integration evidence attached to the executable golden path rather than extra
catalog classes.

## Measures

- task outcome and expected file bytes;
- registered check outcome;
- changed file count and incorrect edit count;
- context entry relevance/provenance;
- provider and tool failures;
- active runtime;
- input/output token usage;
- estimated API cost when explicit rates exist;
- approval count;
- rollback byte equality and restore success.

## Determinism

Tests use deterministic HTTP transports that implement captured Ollama/OpenAI
response contracts. They test the real production adapters and request shapes;
the OpenAI path also crosses the exact remote-egress gate through final review.
They are not alternate fake adapters. No paid provider call is part of CI.

## Adversarial cases

- `../escape`, absolute paths, `.git`, `.env`, and rule-file proposals;
- parent and target symlinks;
- repository text instructing Icarus to ignore host policy;
- malformed/oversized provider JSON;
- provider authorization values reflected in errors;
- command output containing token-like strings;
- timeout/cancellation and partial worktree state;
- unexpected modification between approval and resume;
- more changed files than approved;
- failed verification presented as success.
- source hooks/config/refs that must remain inert through private caching;
- sandbox attempts to read host secrets, reach public/loopback/Tailscale
  services, write the approved worktree, survive cancellation, or exceed limits;
- absent Docker/image/security preflight with no host fallback.

## Evidence retention

Each executable runtime evaluation records its normal run/provider/check
evidence in temporary test state. The catalog evaluator records manifest digest,
result, evidence labels only after their assertions pass, honest unsupported
reasons, and counts in the ignored local report. Generated reports are never
committed.
