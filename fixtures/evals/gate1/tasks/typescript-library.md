Repair the library's numeric clamp behavior.

Allowed change: `src/clamp.ts` only.

The function must return the lower bound for values below the range, the upper bound for values above the range, and the original value for values inside the inclusive range. Preserve the existing public function signature and invalid-range behavior. Use the repository's existing tests to verify the repair.
