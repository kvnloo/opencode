import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Agent } from "undici"
import { resolveTimeoutMs, createUndiciDispatcher } from "@opencode-ai/core/util/undici-dispatcher"
import { which } from "@opencode-ai/core/util/which"

describe("resolveTimeoutMs", () => {
  test("false → 0 (disabled)", () => {
    expect(resolveTimeoutMs(false)).toBe(0)
  })

  test("positive number → that value in ms", () => {
    expect(resolveTimeoutMs(600_000)).toBe(600_000)
  })

  test("undefined → undefined (undici defaults apply)", () => {
    expect(resolveTimeoutMs(undefined)).toBeUndefined()
  })

  test("0 → undefined (not a positive number)", () => {
    expect(resolveTimeoutMs(0)).toBeUndefined()
  })

  test("negative number → undefined", () => {
    expect(resolveTimeoutMs(-1)).toBeUndefined()
  })

  test("null → undefined", () => {
    expect(resolveTimeoutMs(null)).toBeUndefined()
  })

  test("string → undefined", () => {
    expect(resolveTimeoutMs("300000")).toBeUndefined()
  })
})

describe("createUndiciDispatcher", () => {
  test("Bun guard: returns undefined when process.versions.bun is set", () => {
    const original = (process.versions as Record<string, string | undefined>).bun
    ;(process.versions as Record<string, string | undefined>).bun = "1.0.0"
    try {
      expect(createUndiciDispatcher(600_000)).toBeUndefined()
      expect(createUndiciDispatcher(false)).toBeUndefined()
    } finally {
      if (original === undefined) delete (process.versions as Record<string, string | undefined>).bun
      else (process.versions as Record<string, string | undefined>).bun = original
    }
  })

  test("returns undefined when no bun version and timeout resolves to undefined", () => {
    const original = (process.versions as Record<string, string | undefined>).bun
    ;(process.versions as Record<string, string | undefined>).bun = undefined
    try {
      expect(createUndiciDispatcher(undefined)).toBeUndefined()
      expect(createUndiciDispatcher(0)).toBeUndefined()
    } finally {
      if (original === undefined) delete (process.versions as Record<string, string | undefined>).bun
      else (process.versions as Record<string, string | undefined>).bun = original
    }
  })

  // Under Bun, createUndiciDispatcher always returns undefined because of the
  // guard. The Agent construction path only runs under Node. We verify it
  // returns an Agent instance (not private fields) when the bun guard is
  // removed and a valid timeout is provided.
  test("returns an Agent instance under Node (bun guard bypassed)", () => {
    const original = (process.versions as Record<string, string | undefined>).bun
    ;(process.versions as Record<string, string | undefined>).bun = undefined
    try {
      const agent = createUndiciDispatcher(600_000)
      expect(agent).toBeInstanceOf(Agent)
    } finally {
      if (original === undefined) delete (process.versions as Record<string, string | undefined>).bun
      else (process.versions as Record<string, string | undefined>).bun = original
    }
  })
})

// Bun's undici Agent stub does not retain headersTimeout/bodyTimeout on
// Symbol(options). The Desktop sidecar and other Node hosts use real undici,
// so ownership of the transport deadlines must be asserted under Node.
describe("Node undici dispatcher ownership", () => {
  test("timeout:false disables deadlines; finite maps; node-fetch consumer; default regresses to 300s", async () => {
    const node = which("node")
    if (!node) throw new Error("Node is required for the undici Node runtime test")

    const tmp = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-undici-node-"))
    try {
      const dispatcherBundle = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "../../src/util/undici-dispatcher.ts")],
        target: "node",
        format: "esm",
        external: ["undici"],
        outdir: tmp,
      })
      expect(dispatcherBundle.success).toBe(true)

      const nodeFetchBundle = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "../../../sdk/js/src/node-fetch.ts")],
        target: "node",
        format: "esm",
        external: ["undici"],
        outdir: tmp,
      })
      expect(nodeFetchBundle.success).toBe(true)

      const dispatcherUrl = pathToFileURL(path.join(tmp, "undici-dispatcher.js")).href
      const nodeFetchUrl = pathToFileURL(path.join(tmp, "node-fetch.js")).href

      const script = `
import assert from "node:assert/strict"
assert.equal(typeof globalThis.Bun, "undefined", "must run under Node, not Bun")

const { createUndiciDispatcher } = await import(${JSON.stringify(dispatcherUrl)})
const { peekNodeFetchDispatcher } = await import(${JSON.stringify(nodeFetchUrl)})
const { Agent } = await import("undici")

function agentTimeouts(agent) {
  const sym = Object.getOwnPropertySymbols(agent).find((s) => String(s) === "Symbol(options)")
  assert.ok(sym, "Agent exposes Symbol(options)")
  const o = agent[sym]
  return { headersTimeout: o.headersTimeout, bodyTimeout: o.bodyTimeout }
}

// 1) timeout: false → undici deadlines disabled (0)
const disabled = createUndiciDispatcher(false)
assert.ok(disabled instanceof Agent)
assert.deepEqual(agentTimeouts(disabled), { headersTimeout: 0, bodyTimeout: 0 })

// 2) finite provider timeout maps to undici headersTimeout/bodyTimeout
const finite = createUndiciDispatcher(600_000)
assert.deepEqual(agentTimeouts(finite), { headersTimeout: 600_000, bodyTimeout: 600_000 })

// 3) consumer path: SDK node-fetch pins disabled deadlines on Node
const consumer = await peekNodeFetchDispatcher()
assert.ok(consumer instanceof Agent, "node-fetch installs an Agent under Node")
assert.deepEqual(agentTimeouts(consumer), { headersTimeout: 0, bodyTimeout: 0 })

// 4) negative: no custom dispatcher → undici Client defaults (300e3) apply
assert.equal(createUndiciDispatcher(undefined), undefined)
const bare = agentTimeouts(new Agent())
assert.equal(bare.headersTimeout, undefined)
assert.equal(bare.bodyTimeout, undefined)
const UNDICI_DEFAULT_MS = 300e3
assert.equal(bare.headersTimeout ?? UNDICI_DEFAULT_MS, UNDICI_DEFAULT_MS)
assert.equal(bare.bodyTimeout ?? UNDICI_DEFAULT_MS, UNDICI_DEFAULT_MS)

console.log(JSON.stringify({
  disabled: agentTimeouts(disabled),
  finite: agentTimeouts(finite),
  consumer: agentTimeouts(consumer),
  bareDefault: UNDICI_DEFAULT_MS,
}))
`
      const proc = Bun.spawn([node, "--input-type=module", "-e", script], {
        cwd: path.join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const report = JSON.parse(stdout.trim())
      expect(report.disabled).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
      expect(report.finite).toEqual({ headersTimeout: 600_000, bodyTimeout: 600_000 })
      expect(report.consumer).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
      expect(report.bareDefault).toBe(300_000)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
