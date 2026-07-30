/**
 * Which files ARE the TypeScript suite — one definition, read by both sides (#220).
 *
 * `vitest.config.ts` needs it to know what to run. `check-ts-test-skips.mjs` needs it to know what
 * SHOULD have run, and it must decide that WITHOUT asking vitest: the whole point of the check is to
 * catch a run that covered less than the tree holds, and a narrowed `include` (or a path argument, or
 * `--testNamePattern`) narrows anything vitest would answer just as much as it narrows the run. So the
 * gate applies this pattern to the FILESYSTEM instead — the independent enumeration its four siblings
 * get from `go/**\/*_test.go`, python `ast`, php `ReflectionClass` and `cargo metadata`.
 *
 * Independent instrument, but NOT a second definition: the pattern itself lives here so the two cannot
 * drift. Written as a literal in both places it was a copy, and a copy that grew a third directory on
 * one side only would leave the gate demanding files vitest never ran (red, so survivable) or — the
 * direction that matters — leave the gate blind to a directory it had never heard of.
 */
export const TEST_INCLUDE = 'test/**/*.test.ts';
