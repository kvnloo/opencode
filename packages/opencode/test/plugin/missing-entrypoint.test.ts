import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { PluginLoader } from "../../src/plugin/loader"

describe("PluginLoader missing server entrypoint", () => {
  test("server kind: missing entrypoint invokes report.missing exactly once with path context", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Package exists but has no server entrypoint — triggers resolve stage "missing".
        const mod = path.join(dir, "mods", "ghost-plugin")
        await fs.mkdir(mod, { recursive: true })
        await Bun.write(
          path.join(mod, "package.json"),
          JSON.stringify({
            name: "ghost-plugin",
            type: "module",
            // TUI-only export: valid for theme packages, missing for server kind.
            exports: { "./tui": "./tui.js" },
          }),
        )
        await Bun.write(path.join(mod, "tui.js"), "export default {}\n")
        return { mod, spec: pathToFileURL(mod).href }
      },
    })

    const missing: Array<{ spec: string; message: string }> = []
    const errors: Array<{ stage: string; spec: string }> = []

    const loaded = await PluginLoader.loadExternal({
      items: [{ spec: tmp.extra.spec, source: path.join(tmp.path, "opencode.json"), scope: "local" }],
      kind: "server",
      report: {
        start() {},
        missing(candidate, _retry, message) {
          missing.push({ spec: candidate.plan.spec, message })
        },
        error(candidate, _retry, stage) {
          errors.push({ stage, spec: candidate.plan.spec })
        },
      },
    })

    expect(loaded).toEqual([])
    expect(errors).toEqual([])
    expect(missing).toHaveLength(1)
    expect(missing[0]?.spec).toBe(tmp.extra.spec)
    expect(missing[0]?.message.length).toBeGreaterThan(0)
  })

  test("control: tui kind still uses report.missing (warn path), not silenced", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const mod = path.join(dir, "mods", "server-only")
        await fs.mkdir(mod, { recursive: true })
        await Bun.write(
          path.join(mod, "package.json"),
          JSON.stringify({
            name: "server-only",
            type: "module",
            // Server export only — missing for tui kind.
            exports: { "./server": "./server.js" },
          }),
        )
        await Bun.write(path.join(mod, "server.js"), "export default {}\n")
        return { mod, spec: pathToFileURL(mod).href }
      },
    })

    const missing: string[] = []
    await PluginLoader.loadExternal({
      items: [{ spec: tmp.extra.spec, source: path.join(tmp.path, "tui.json"), scope: "local" }],
      kind: "tui",
      report: {
        start() {},
        missing(candidate) {
          missing.push(candidate.plan.spec)
        },
        error() {},
      },
    })
    // Prior TUI policy: missing is reported to the caller's handler (warn), not silenced.
    expect(missing).toEqual([tmp.extra.spec])
  })

  test("negative: neutralizing report.missing leaves the failure silent", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const mod = path.join(dir, "mods", "ghost-plugin")
        await fs.mkdir(mod, { recursive: true })
        await Bun.write(
          path.join(mod, "package.json"),
          JSON.stringify({ name: "ghost-plugin", type: "module", exports: { "./tui": "./tui.js" } }),
        )
        await Bun.write(path.join(mod, "tui.js"), "export default {}\n")
        return { mod, spec: pathToFileURL(mod).href }
      },
    })

    const missing: string[] = []
    await PluginLoader.loadExternal({
      items: [{ spec: tmp.extra.spec, source: path.join(tmp.path, "opencode.json"), scope: "local" }],
      kind: "server",
      report: {
        start() {},
        // Pre-fix server wiring: empty missing callback.
        missing() {},
        error() {},
      },
    })
    // Assertion that production wiring must satisfy — fails under neutralized callback.
    expect(missing).toHaveLength(0)
    expect(missing).not.toHaveLength(1)
  })
})

describe("server plugin report.missing wiring", () => {
  test("plugin index wires missing → publishPluginError (source pin + behavioral contract)", async () => {
    const src = await Bun.file(new URL("../../src/plugin/index.ts", import.meta.url)).text()
    expect(src).toContain("publishPluginError(`Failed to load plugin ${candidate.plan.spec}: ${message}`)")
    // Must not keep the empty no-op that hid missing server plugins.
    expect(src).not.toMatch(/missing\(candidate,\s*_retry,\s*message\)\s*\{\s*\}/)
  })
})
