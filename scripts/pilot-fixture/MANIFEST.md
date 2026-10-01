# Chat A — File manifest

The attached `ORAC-IOS-SOURCE-OF-TRUTH-20260927-153926.zip` snapshot has no
`.git` history (it's a file snapshot, not a repo checkout), so this chat
cannot produce a real `codex/` branch + PR diff as the plan's default format
describes. Per the plan's own accepted alternative ("one self-contained
implementation packet"), this is delivered as a packet instead. **Every file
below is a new addition — nothing in the existing source tree was modified
or deleted.** Apply these paths onto the real git checkout and commit there
to get the branch/PR the plan asks for.

```
backend/
  scripts/pilot-fixture/
    build-fixture-records.mjs        NEW — pure mapper, fixture spec -> real schema records
    load-pilot-fixture.mjs           NEW — guarded, idempotent CLI loader
    verify-pilot-fixture.mjs         NEW — independent, read-only verifier
    fixture-scenarios.source.json    NEW — copy of the input fixture spec (provenance only)
    EXPECTED_RESULTS.source.json     NEW — copy of the input expected-results file (provenance only)
    BENCHMARK.md                     NEW — required short online benchmark, with citations
    GAPS_REPORT.md                   NEW — honest, evidence-cited gaps report
    VALIDATION_REPORT.md             NEW — every command run in this chat + real observed output
    RUN_COMMANDS.md                  NEW — exact commands to reproduce every result
    CONTINUATION_NOTE.md             NEW — handover for the next chat/session
    EVIDENCE_CHECKLIST.md            NEW — owner tick-list for a real non-production run
    MANIFEST.md                      NEW — this file
  tests/
    pilotFixtureNegativeScenarios.test.js   NEW — 6 real tests for fixture NT-01..NT-04
  tests/pilotFixtureLoaderValidation.test.js NEW — 3 tests for FK validation / rejected reporting
```

No file outside `backend/scripts/pilot-fixture/` and
`backend/tests/pilotFixtureNegativeScenarios.test.js` was touched. In
particular: no change to `src/store.js`, `src/postgresStore.js`,
`src/stateMachine.js`, `src/schemas.js`, `src/permissions.js`,
`src/internalWorkRequestRules.js`, any controller, any route, or any
frontend file. `npm test` before this packet: 327/327 passing. After: 333/333
passing (see `VALIDATION_REPORT.md`).

`chat-a.patch` (unified diff vs the source snapshot, 14 new files, 0 modified) is included alongside this manifest.
