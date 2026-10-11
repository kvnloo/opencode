# OpenCode #54372: independent model-filter evidence

Owner implementation: **cleardevice**, PR [#54372](https://github.com/anomalyco/opencode/pull/54372), head `939179ed098a0d265095bd607190139bbcdd5053`, base `7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937`.

This evidence was prepared with AI assistance and independently replayed by a second AI reviewer. It contains no production fix. The public `models["*"]` shape remains subject to maintainer design approval. Earlier wildcard diagnostics/Console-registration review issues were addressed by cleardevice and are not reported as current defects.

## Finding

The `google-vertex-anthropic` compatibility migration adds a package to **every** migrated model ([migrate.ts:155–170](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/v1/config/migrate.ts#L155-L170)), including entries synthesized solely from whitelist/blacklist IDs ([126–136](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/v1/config/migrate.ts#L126-L136)). That package defeats the new `isToggleOnly` skip guard ([provider.ts:76–85](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/config/plugin/provider.ts#L76-L85), [177–183](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/config/plugin/provider.ts#L177-L183)).

For a missing whitelist ID, migration produces `disabled:false` and the production provider callback requests model creation. A missing blacklist ID gets `disabled:true` and also requests creation, a lower-impact instance. The real provider editor creates a default model for an absent ID on update ([core/provider.ts:361–382](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/provider.ts#L361-L382)); the later model callback maps `disabled` to `enabled` ([config/provider.ts:158](https://github.com/anomalyco/opencode/blob/939179ed098a0d265095bd607190139bbcdd5053/packages/core/src/config/plugin/provider.ts#L158)). Those creation/enabled-assignment implementations were inspected, not executed by this portable runner. The blacklist-only case has no wildcard, so it does not depend on approving a replacement wildcard shape.

Expected contract: an ID absent from the source/current catalog and supplied only in whitelist/blacklist should be skipped, as it is for an ordinary provider. Explicitly authored package/name metadata remains an intentional custom definition.

## Checkout and dependency contract

- Put this directory at `evidence/opencode-54372/` in a checkout based on the exact owner head. An evidence-only commit on top is fine; the three referenced production source blobs must remain unchanged. `source-hashes.json` records their Git blob SHAs.
- Use Node 20 or newer and an **already installed** TypeScript 5.x dependency resolvable from the checkout's `package.json`. Verified preparation used Node 24.19.0 / TypeScript 5.9.3. The runner does not install packages or download anything.
- If TypeScript is installed elsewhere, set `OPENCODE_REVIEW_TYPESCRIPT` to that existing module's path or resolvable module name. No credentials are needed.
- For another working directory, supply `--repo /path/to/checkout`. The default is the repository root two levels above this directory.
- The small base-function snapshot is frozen from the specified base blob; its hash and original extraction ranges are in `source-hashes.json`. No base Git object or network request is needed at replay time.

From this directory:

```sh
node replay.cjs --output observed-results.json
node replay.cjs --contract --output contract-results.json
```

Observation mode: **8 checks pass, exit 0**. Frozen intended-contract mode: **6 controls pass, 2 assertions fail, exit 1**, with expected `[]` and actual `["missing"]` for Vertex whitelist/blacklist creation requests. Source-hash verification is an additional prerequisite, not counted among the eight checks. Exit 2 means a source/dependency prerequisite is missing.

The two modes exercise the same fixtures; do not add their counts together. `observed.log`, `contract.log` and matching JSON files contain sanitized frozen results. The package-deletion mechanism control changes only a fixture object. Its pass is not evidence of a production fix or green implementation.

## Verification limits

These are **extracted-function/callback checks**, not full CLI/provider acceptance. The runner AST-extracts the exact owner migration functions, provider callback and helper predicates. Its editor only records requested model updates; it does not invent or emulate default-model behavior.

No actual normalization/Schema decoding, Effect runtime, immutable catalog fold, model transform, activation/policy, resolver, plugin host, live Console/provider request, credentials, Bun suite, typecheck, or E2E acceptance was run. Empty provider-options processing and package-name mapping use narrow stubs. Baseline cases are filter-only, so `migrateModel` is not invoked. The explicit package/name control uses a directly authored config definition, not a Schema decode.

The independent reviewer also ran a separate schema-free six-check proof and intended-contract failure. Those corroborating checks are not added to the portable runner's count. Maintainers and cleardevice retain ownership of design and implementation decisions.
