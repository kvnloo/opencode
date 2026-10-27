# Issue #46814 Audit: SubagentTool in Code Mode

**Date:** 2026-09-02
**Worktree:** `/mnt/zer0models/worktrees/opencode-codemode-subagent`
**Verdict:** Public plugin APIs are insufficient. No smallest complete candidate is possible on upstream/dev without maintainer-approval-gated internal changes.

---

## 1. What the Issue Asks For

Evaluate `subagent` (the `TaskTool`, tool ID `"task"`) as an opt-in Code Mode tool so the LLM can write:

```js
const results = await Promise.all([
  tools.subagent({ agent: "explore", prompt: "..." }),
  tools.subagent({ agent: "explore", prompt: "..." }),
])
return results.map(r => ({ sessionID: r.sessionID, status: r.status, summary: r.summary }))
```

Acceptance cases: independent calls overlap (subject to concurrency cap), durable child session IDs, one failure doesn't erase siblings, aborting parent cancels children, bounded structured output, nested delegation blocked by depth/permission, behavior unchanged when plugin disabled.

---

## 2. Current Architecture

### Code Mode (`packages/opencode/src/tool/code-mode.ts`)

- `CodeModeTool` (tool ID `"execute"`) is lazily loaded when `OPENCODE_EXPERIMENTAL_CODE_MODE` is set.
- It gathers **MCP tools only** via `mcp.tools()` (line 210), groups by server, and builds a `SandboxTool.Definition` tree.
- Built-in tools (`task`, `read`, `write`, `edit`, `bash`, etc.) are **not** included in the Code Mode sandbox.
- Each sandbox tool's `run` calls `invokeChildTool()` which fires plugin hooks, asks permission via `ctx.ask()`, and calls `client.callTool()` on the MCP transport.
- Concurrency: `Semaphore(8)` in the interpreter (`packages/codemode/src/stdlib/promise.ts:6`); un-awaited calls eagerly fork on child fibers.
- Cancellation: `Effect.raceFirst` against host abort signal (line 274).

### SubagentTool / TaskTool (`packages/opencode/src/tool/task.ts`)

Internal services required (lines 84-90):

| Service | Purpose |
|---|---|
| `Agent.Service` | Agent definition resolution (`agent.get(subagent_type)`) |
| `BackgroundJob.Service` | Background task lifecycle (start, wait, cancel, waitForPromotion) |
| `Config.Service` | `subagent_depth` config for nesting limits |
| `Session.Service` | Session create/get for child sessions |
| `Scope.Scope` | Fiber management for background result injection |
| `RuntimeFlags.Service` | `experimentalBackgroundSubagents` flag |
| `Database.Service` | Message retrieval for model/variant info (line 174-177) |

Critical runtime dependency — `TaskPromptOps` (lines 18-22, injected at line 197):

```ts
interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}
```

This is injected by `session/tools.ts` line 64:
```ts
extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps }
```

`TaskTool` consumes it at line 197-198:
```ts
const ops = ctx.extra?.promptOps as TaskPromptOps
if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
```

### Public Plugin Tool API (`packages/plugin/src/tool.ts`)

`ToolContext` (lines 3-20) exposes:

| Member | Available |
|---|---|
| `sessionID` | yes |
| `messageID` | yes |
| `agent` | yes |
| `directory`, `worktree` | yes |
| `abort` (AbortSignal) | yes |
| `metadata(input)` | yes — update tool call display |
| `ask(input)` | yes — permission check |
| Session create/resume | **no** |
| Prompt dispatch to child session | **no** |
| Agent resolution (get/list agents) | **no** |
| Background job management | **no** |
| Config access | **no** |
| Any session/job lifecycle service | **no** |

### v2 Plugin API (`packages/plugin/src/v2/effect/context.ts:12-22`)

`PluginContext` domains: `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`, `reference`, `skill`.

**No `tool` domain.** Explicitly documented gap in `packages/core/src/tool/AGENTS.md:57-58`:
> "Plugin boot has not been redesigned to register canonical tools through `Tools.Service`; do not redesign it as part of leaf migrations."

### Internal Plugin Runtime (issue #34957)

`PluginInternal` injects ~28 Location services into internal plugin effects. `PluginRuntime.Service` (internal-only, referenced in #34957) exposes `session.{get,create,messages,prompt,resume,interrupt,synthetic}` and `job.{start,wait,block,background,cancel}`. None of this is on the public API.

---

## 3. Five Missing Public API Seams

### Seam 1: No Tool Domain in v2 PluginContext

**Source:** `packages/plugin/src/v2/effect/context.ts:12-22`
**Gap doc:** `packages/core/src/tool/AGENTS.md:57-58`

A v2 plugin cannot register tools at all. Only the legacy v1 `Hooks.tool` map works, but see Seam 2.

### Seam 2: Public `ToolContext` Lacks Session Lifecycle

**Source:** `packages/plugin/src/tool.ts:3-20`

`ToolContext` has no `createSession`, `promptSession`, `getAgent`, or `BackgroundJob` methods. A plugin tool cannot spawn child sessions, dispatch prompts, or manage background jobs — exactly the operations `TaskTool` requires.

### Seam 3: Code Mode Only Bridges MCP Tools

**Source:** `packages/opencode/src/tool/code-mode.ts:210`
```ts
const mcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
```

**Source:** `packages/opencode/src/tool/code-mode.ts:120-132` — `toolTree()` only builds from MCP `CatalogEntry[]`.

**Source:** `packages/opencode/src/session/tools.ts:388`
```ts
if (flags.experimentalCodeMode) return tools
```

When `experimentalCodeMode` is on, individual MCP tools are hidden; only the `execute` tool is exposed. Built-in tools (`task`, `read`, `write`, `edit`, `bash`) are invisible to Code Mode's sandbox.

### Seam 4: `TaskPromptOps` Is Session-Processor-Specific

**Source:** `packages/opencode/src/tool/task.ts:18-22` (type), `task.ts:197` (usage)

`TaskPromptOps` wraps `SessionPrompt.prompt()`, which is the session-level prompt dispatch loop. This is only available inside the session processor context (via `session/tools.ts` → `extra.promptOps`).

`code-mode.ts` does not pass `ctx.extra` through to sandbox tools; each sandbox tool's `run` receives only the decoded input, not the host `Tool.Context`. Even an internal change to register `task` as a Code Mode sandbox tool would need to thread `promptOps` through the Code Mode execution boundary.

### Seam 5: Code Mode Sandbox Tools Cannot Access Host Context

**Source:** `packages/opencode/src/tool/code-mode.ts:220-237`

Each sandbox tool's `run` closure captures `ctx: Tool.Context` via the `callTool` factory (line 220), but the Code Mode interpreter's `invokeTool` path does not expose `Tool.Context` to the sandbox function — it only receives the decoded input arguments. The host context (`ctx`) is captured in the `callTool` closure but is not part of the sandbox's `run(input)` signature.

---

## 4. Why a Plugin Cannot Preserve SubagentTool Semantics

A v1 plugin tool (`packages/plugin/src/tool.ts:45-51`) receives `ToolContext` and returns `Promise<ToolResult>`. To faithfully implement subagent semantics, it would need:

1. **Session creation:** `Session.Service.create({ parentID, title, agent, permission })` — not on `ToolContext`.
2. **Prompt dispatch:** `SessionPrompt.prompt({ sessionID, model, parts })` — not on `ToolContext`. This is the core execution loop that runs the child agent to completion.
3. **Agent resolution:** `Agent.Service.get(subagent_type)` — not on `ToolContext`. The v2 `PluginContext.agent` domain has `AgentHooks` (registration), not agent lookup.
4. **Permission derivation:** `deriveSubagentSessionPermission()` (`packages/opencode/src/agent/subagent-permissions.ts`) — requires `Session.Permission` rules from the parent session, available only via `Session.Service`.
5. **Depth limit enforcement:** Walks the `parentID` chain via `Session.Service.get()` (task.ts:104-110) — not available.
6. **Background job management:** `BackgroundJob.Service.{start,wait,cancel}` — not on `ToolContext`.
7. **Cancellation propagation:** `ops.cancel(childSessionID)` — requires prompt dispatch, which is unavailable.

**Without these, any plugin reimplementation would be one of:**
- A stub that delegates back to the internal `TaskTool` (bypassing the plugin boundary)
- A reimplementation that lacks session lifecycle (no durable child sessions, no prompt dispatch)
- A wrapper that calls the server HTTP API (adds latency, loses abort signal propagation, bypasses in-process permission checks)

None of these preserve SubagentTool semantics.

---

## 5. Overlapping Open PRs

| PR | Title | Overlap Area |
|---|---|---|
| #46788 | `fix(core): reuse the Code Mode catalog across tool snapshots` | Code Mode catalog materialization — #46814 implementation would conflict if catalog structure changes |
| #46541 | `refactor(core): nest code mode catalog` | Restructures Code Mode tool catalog to nested `Tool | Namespace` union — directly affects how tools appear in the sandbox |
| #45206 | `feat(core): add code mode namespace instructions` | Adds `namespaceInstructions` for namespaced Code Mode tools — relevant if `subagent` is added as a namespace |
| #45572 | `refactor(plugin): reuse tool executor conversion` | Shares executor conversion for Promise plugins; handles `codemode: false` — affects plugin tool registration flow |
| #45325 | `fix(core): isolate invalid tool registrations` | Prevents bad registrations from breaking healthy tools — relevant if new tool categories are added |
| #38367 | `refactor(tools): unify tool APIs and result handling` | Unified tool stack from authored tools through Code Mode — broad refactor that could change how built-in tools integrate |
| #43282 | `fix(core): expose valid subagent IDs in the subagent tool` | Modifies subagent tool description/targets — changes the `task` tool surface |
| #41100 | `fix(opencode): enforce per-target task subagent permissions` | Subagent permission enforcement — relevant to how permissions would be preserved in Code Mode |
| #41683 | `fix(opencode): refresh task resume permissions` | Task resume permission refresh — touches `TaskTool` permission path |

No existing PR specifically addresses exposing `task`/subagent through Code Mode.

---

## 6. Smallest PR Shape After Maintainer Approval

### Recommended: Option A — Register `task` as a Code Mode Tool in `code-mode.ts`

**Scope:** ~150 lines in 1 file + test additions in 1 test file.

**Changes to `packages/opencode/src/tool/code-mode.ts`:**
1. Import `TaskTool` (or its `Parameters` + execution logic) and `BackgroundJob.Service`, `Agent.Service`, `Config.Service`, `RuntimeFlags.Service`, `Database.Service`.
2. In `CodeModeTool.execute()`, after building the MCP `toolTree`, add a `subagent` namespace tool entry that wraps the `TaskTool` execution path.
3. Thread `ctx.extra.promptOps` (cast from `Tool.Context.extra`) into the sandbox tool's `run` closure.
4. Apply the same `invokeChildTool`-style permission checking and plugin hook firing.
5. Return bounded structured output `{ sessionID, status, summary }` from the sandbox tool.

**Changes to `packages/opencode/test/tool/code-mode.test.ts`:**
1. Add test: `task` sandbox tool appears in Code Mode catalog when enabled.
2. Add test: independent `subagent` calls overlap within concurrency cap.
3. Add test: one child failure is visible and does not erase successful siblings.
4. Add test: aborting parent cancels in-flight children.
5. Add test: nested subagent delegation is blocked by depth limit.
6. Add test: behavior is unchanged when Code Mode is disabled.

**Key architectural decision:** The sandbox tool wraps the existing `TaskTool` execution path — it does not reimplement lifecycle. The `Tool.Context.extra.promptOps` bridge is internal-only (not a public API change). This follows the pattern of #34957's documented internal-only approach.

**Rebase requirement:** Should be rebased on top of #46541 (nested catalog) and #46788 (catalog reuse) to avoid conflicts with Code Mode catalog restructuring.

### Alternative: Option B — Add Session/Job Domains to Public PluginContext

**Scope:** ~400 lines across 5+ files. Requires design review per CONTRIBUTING.md.

**Changes:**
1. `packages/plugin/src/v2/effect/context.ts` — add `session: SessionHooks & Reload` and `job: JobHooks`.
2. `packages/core/src/plugin/host.ts` — implement new domains delegating to internal services.
3. `packages/plugin/src/tool.ts` — extend `ToolContext` with session/job capabilities.
4. A v1 plugin tool could then implement subagent logic.

**Blockers:** Design review; blocks on #34957; larger blast radius.

### Alternative: Option C — `codemode` Tool Category in Registry

**Scope:** ~250 lines across 3 files.

**Changes:**
1. `packages/opencode/src/tool/registry.ts` — add `codemode` tool category.
2. `packages/opencode/src/tool/code-mode.ts` — include `codemode`-registered tools in sandbox tree.
3. `packages/opencode/src/tool/task.ts` — register as Code Mode tool with `promptOps` bridge.

---

## 7. Recommendation

1. **Do not force an implementation.** The public plugin APIs lack the three seams needed: (a) tool domain in v2 `PluginContext`, (b) session/job lifecycle in `ToolContext`, (c) built-in tool bridging in `CodeModeTool`.

2. **Blocker: maintainer approval.** CONTRIBUTING.md states: "any UI or core product feature must go through a design review with the core team before implementation." The issue itself says "Evaluate" — implying design exploration, not implementation green-light.

3. **Smallest PR shape after approval:** Option A (~150 lines, 1 file + tests). Reuses existing `TaskTool` code path; preserves all lifecycle guarantees; internal-only `promptOps` bridge.

4. **Precedent for future:** Option B is the public-API path but requires design review per #34957. Option C is a middle ground.

5. **Overlap risk:** PRs #46541 and #46788 are restructuring the Code Mode catalog. Any implementation should rebase on top of these.
