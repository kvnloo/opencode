# OpenCode #52667: owner-head evidence only

Implementation credit: yaohuangguan, https://github.com/anomalyco/opencode/pull/52667.
Prepared with AI assistance as an independent review. This folder contains evidence and review fixtures; no production fix.

Pinned owner head: e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1.
Base: 7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937.
Intended downstream evidence branch base is that exact owner head. An evidence-only descendant can reproduce this packet because hashes gate unchanged owner source files. No Git write or remote action is performed by the scripts.

## Finding and baseline

The writer's legacy detector only recognizes typed local/remote entries. The exact-head legacy schema also permits { enabled: boolean } overrides.

- A flat map containing only an enabled-only ordinary entry selects mcp.servers.probe.
- A legacy entry literally named servers with {enabled:false}, even beside a typed github server, is mistaken for the native container. After the selected nested insertion, normalizeMcp's enabled-only branch omits that entire entry before container traversal.
- The new effective probe addition is omitted in the literal-servers case. The pre-existing typed github sibling survives. This is not a claim of loss of existing working typed servers.
- The base writer already always selected mcp.servers.<name>. This is an incomplete compatibility fix, not a newly introduced regression.
- The two flat-preservation RED expectations are frozen conditional probes of the author's stated goal. Maintainer/owner approval of the detection rule remains open.

Sources:
- Writer: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/cli/src/commands/handlers/mcp/add.ts#L64-L80
- Legacy schema: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/core/src/v1/config/config.ts#L112-L114
- Omission branch: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/core/src/config/normalize.ts#L260-L292
- Predicate: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/core/src/config/normalize.ts#L784-L789
- Existing reserved-name test: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/core/test/config/normalization.test.ts#L347-L364
- Read path: https://github.com/anomalyco/opencode/blob/e8f3fddf9913adc1254cd50ad3d65ed798e0b4e1/packages/core/src/config.ts#L104-L127
- Base writer: https://github.com/anomalyco/opencode/blob/7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937/packages/cli/src/commands/handlers/mcp/add.ts#L59-L67

## Requirements and reproduction

Requires Node v24 with built-in stripTypeScriptTypes; verified on v24.19.0. No Bun, npm install, Effect, jsonc-parser, credentials or network access are required for this extracted-source packet.

A checkout/source snapshot must already contain the seven exact files listed in source-identities.json. No source files are copied into this packet. In a sparse/partial checkout, materialize those files through the checkout's authorized workflow first; the scripts do not fetch them. No .git access is needed to run the hash-gated checks.

From the owner-head checkout (or an evidence-only descendant), use:

    node --disable-warning=ExperimentalWarning evidence/opencode-52667/run.mjs --repo . --mode observations
    node --disable-warning=ExperimentalWarning evidence/opencode-52667/run.mjs --repo . --mode preservation-red
    node --disable-warning=ExperimentalWarning evidence/opencode-52667/identity-negative.mjs --repo .

Expected process exits:
- observations: 0, 24 PASS checks
- preservation-red: 1, two frozen conditional expectations fail
- identity-negative: 0, rejects an in-memory one-byte source mutation

The intentionally failing second command is evidence of the uncovered case. Do not describe it as a passing writer test. The source identity gates fail rather than silently reading a changed owner implementation.

## Evidence boundaries

Exact original selector statements, functions and normalizer helpers are mechanically extracted and type-stripped. Two minimal enabled:false/true collision checks execute extracted normalizeMcp and invoke zero codec stand-ins. Four normalizer controls use explicitly narrow valid-local decode/canonicalization stand-ins. The 18 remaining observations cover shape selection and the enabled-only predicate, including empty/native/mixed maps and server names servers/timeout.

No actual writeMcpConfig import, JSONC parse/edit, filesystem config write, comment/trailing-comma acceptance, CLI invocation, Effect or final Info decode, or MCP launch is tested. A plain-object target simulation is explicitly labeled. The genuine-comment fixtures are unexecuted acceptance inputs.

Existing repository writer tests cover three simple new/typed-legacy/native configurations. Both JSONC-named inputs are JSON.stringify output. Actual comments and these enabled-only cases still need owner-controlled writer tests and package verification in an environment with the required dependencies.

observations.log, preservation-red.log and identity-negative.log are stable path-free outputs from the reproducible commands. Source identity and extraction evidence was independently checked; the six normalizer checks preserve the independent verifier's zero-codec collision proof and typed-sibling-survival controls.

This packet is for downstream evidence-only publication. No upstream post or production change is included.

