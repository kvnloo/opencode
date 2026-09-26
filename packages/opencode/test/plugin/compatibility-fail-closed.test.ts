import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { checkPluginCompatibility } from "../../src/plugin/shared"

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plugin-compat-"))
  try {
    return await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("checkPluginCompatibility fail-closed package read", () => {
  test("refuses when package.json is malformed JSON", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "package.json"), "{ not-json", "utf8")
      const target = pathToFileURL(dir).href
      await expect(checkPluginCompatibility(target, "2.0.16")).rejects.toThrow(
        /could not be read for compatibility check/,
      )
    })
  })

  test("refuses when package.json is missing", async () => {
    await withTempDir(async (dir) => {
      const target = pathToFileURL(dir).href
      await expect(checkPluginCompatibility(target, "2.0.16")).rejects.toThrow(
        /could not be read for compatibility check/,
      )
    })
  })

  test("still enforces engines.opencode when package is readable", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "demo", engines: { opencode: "^1.0.0" } }),
        "utf8",
      )
      const target = pathToFileURL(dir).href
      await expect(checkPluginCompatibility(target, "2.0.16")).rejects.toThrow(
        /Plugin requires opencode \^1\.0\.0 but running 2\.0\.16/,
      )
    })
  })

  test("accepts a satisfied engines.opencode range", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "demo", engines: { opencode: ">=2.0.0" } }),
        "utf8",
      )
      const target = pathToFileURL(dir).href
      await expect(checkPluginCompatibility(target, "2.0.16")).resolves.toBeUndefined()
    })
  })
})
