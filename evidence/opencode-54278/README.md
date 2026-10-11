# OpenCode #54278: independent YAML-context evidence

**Verdict: APPROVE this bounded regression evidence. HOLD native/pinned-runtime acceptance.**

The source-function witness reproduces two forms of context loss in `sanitize()` at owner head
`522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee`:

1. A multiline flow `request` object or `permissions` array is rewritten as a quoted opening delimiter. The remaining continuation lines make the recovery output invalid YAML.
2. A valid flow array containing a previously defined YAML alias becomes the string `"[*rule]"`. The line-only probe cannot see the earlier anchor.

These require the **fallback** path, here triggered by the already-supported `description: Scope: test` tolerance. The original whole documents are not valid strict YAML until that description is repaired. Their flow collections are otherwise valid. Quoting only the description makes every control pass on head because the first parse succeeds and `sanitize()` is never called.

The three intended-contract recovery assertions pass on exact base
`7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937` and fail on exact head. Tests expect preservation, not the broken result.

## Critical runtime limit

**OpenCode's pinned gray-matter 4.0.3 and js-yaml 3.15.1 were NOT executed.**

Exact-head `bun.lock`, read via its Git blob `0d5fe6b5ee2586ff13008ee3e8f33764200a8121`, records gray-matter 4.0.3 / `js-yaml ^3.13.1` at line 4192 and js-yaml 3.15.1 at line 4468. There is no gray-matter/js-yaml override or nested lock entry replacing that resolution. The contents endpoint returned empty; the read-only blob endpoint returned the source text. No runtime package was downloaded or installed.

The upstream gray-matter engine source examined uses `yaml.safeLoad`; its repository package file advertises 4.0.3. That is a source inspection, not execution or verification of a separate published release archive.

The two distinct corroborations actually executed were:

- Existing **js-yaml 4.3.2**, using `load`, under Node v24.19.0
- Existing **yaml 2.9.1**, using `parse`, under Node v24.19.0

The runner supplies an explicit minimal frontmatter/YAML adapter to the unchanged extracted functions. It does not implement gray-matter cache, alternate delimiters/languages, or the full application. Do not report these results as gray-matter, cache, Effect schema execution, Agent.Service, registry, native Bun tests, typecheck, CI or end-to-end acceptance. Neither adapter establishes behavior for every YAML feature in the pinned engine.

## Reproduce with already-installed dependencies

This directory is portable: it contains the complete frozen base/head `markdown.ts` files and checks their Git blob identities before running. It vendors no dependencies and performs no installation, networking or provider calls. Use Node with `node:module.stripTypeScriptTypes` (tested v24.19.0).

From this directory, point the variables to existing package directories containing their `package.json` files:

```sh
JS_YAML=/absolute/path/to/existing/node_modules/js-yaml  # must be 4.3.2
YAML=/absolute/path/to/existing/node_modules/yaml        # must be 2.9.1

node critic.cjs base js-yaml "$JS_YAML"  # exit 0: 6/6 PASS
node critic.cjs head js-yaml "$JS_YAML"  # exit 1: 3 controls PASS, 3 recovery RED
node critic.cjs base yaml "$YAML"        # exit 0: 6/6 PASS
node critic.cjs head yaml "$YAML"        # exit 1: 3 controls PASS, 3 recovery RED
```

The runner deliberately rejects other package names/versions rather than imply unverified runtime compatibility. If these dependencies are unavailable, the recorded logs remain inspectable; do not substitute the pinned js-yaml 3.15.1 into this `load` adapter and call that native validation.

Each head run shows:

- `multiline-request/colon-recovery`: parsing throws; bounded `parseOption` returns `undefined`
- `multiline-permissions/colon-recovery`: parsing throws; bounded `parseOption` returns `undefined`
- `alias-permissions/colon-recovery`: assertion fails because `permissions` is a string, while the anchored request-body object is retained
- The corresponding quoted-description controls all pass

The four `.log` files record final portable-runner executions. `evidence.json` includes source identities, dependency excerpts and exact result counts. `SHA256SUMS` covers all packet files except itself.

## Why these fields count

These witnesses use native agent fields, not unsupported top-level `tags` or ambiguous legacy `tools` examples:

- [`ConfigAgent.Info`](https://github.com/anomalyco/opencode/blob/522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee/packages/schema/src/config/agent.ts#L11-L22) explicitly permits `request`, string `description`, `mode: subagent` and `permissions`.
- [`ConfigProvider.Request`](https://github.com/anomalyco/opencode/blob/522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee/packages/schema/src/config/provider.ts#L29-L46) supports string-valued headers and a JSON-record body. The alias fixture puts an acyclic JSON rule object in that supported body.
- [`Permission.Ruleset`](https://github.com/anomalyco/opencode/blob/522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee/packages/schema/src/permission.ts#L56-L67) is an array of string `action`, string `resource` and `allow`/`deny`/`ask` `effect` objects. The expected fixtures conform by static inspection.
- [`decode()`](https://github.com/anomalyco/opencode/blob/522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee/packages/core/src/config/plugin/agent.ts#L177-L204) returns for absent parsed markdown, then uses native `ConfigAgent.Info` decoding for these keys. **Inference from source:** the multiline failures lead to the early parse drop; the alias string is incompatible with the native permissions-array schema and would lead to the schema-decode drop. We did not execute those application paths. This is not evidence of an accepted agent silently losing a deny rule.

## Provenance and credit

- [PR #54278](https://github.com/anomalyco/opencode/pull/54278) belongs to **SeashoreShi**, author of the production fix and current tests. At the independent refresh it remained open at the exact head above.
- **opencode-agent[bot]** already identified the earlier single-line flow-mapping fallthrough issue. SeashoreShi addressed it; this packet does not claim that fixed finding as new.
- **argszero** suggested the Agent.Service registry guard in the PR discussion; SeashoreShi reports adding it in the latest commit. This packet does not claim authorship or execution of that guard.
- The multiline/alias witnesses were first identified in an OpenAI-assisted owner-safe review, then independently corroborated with a separate fixture/runner in this packet. Packet preparation and independent tests are **AI-assisted review work**, not a competing production implementation.

Frozen source provenance:

- `frozen/base-markdown.ts`: [base source](https://github.com/anomalyco/opencode/blob/7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937/packages/core/src/config/markdown.ts), Git blob `8093ff7e735429fc9eb8750578d9e136db63c46f`
- `frozen/head-markdown.ts`: [head source](https://github.com/anomalyco/opencode/blob/522f93f24c9a3c715fb8e5e7b7a53666ef3b82ee/packages/core/src/config/markdown.ts), Git blob `c39f4305b77783e426f069981ddf4cb899a44739`

Both blobs and all four schema/decode source identities in `evidence.json` were independently matched against read-only GitHub connector results. Frozen functions remain unchanged apart from removing import/export syntax and stripping TypeScript types in memory for the witness.

## Publication and next verification boundary

Suitable destination: an evidence-only directory such as `review-evidence/opencode-54278-yaml-context/` on a non-default branch based on the exact owner head. No production fix, commit, branch, push or upstream post was made during this review. Publication is left to the coordinating reviewer.

Before calling this native acceptance, an authorized environment with the actual locked dependencies must run assertions against real `ConfigMarkdown.parse` and `Agent.Service` at the exact owner head/base. Keep the successful quoted-description controls, both collection forms and the defined-alias case. That work is explicitly outside this packet.
