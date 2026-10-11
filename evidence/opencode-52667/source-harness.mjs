import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import { isDeepStrictEqual } from "node:util"

const manifest = JSON.parse(readFileSync(new URL("./source-identities.json", import.meta.url), "utf8"))
export function verifyOwnerBytes(path, bytes) {
  const expected = manifest.sources[path]
  assert.ok(expected, "source path is outside pinned manifest")
  const blob = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  assert.equal(blob, expected.git_blob_sha1, "pinned owner source mismatch: " + path)
  assert.equal(sha256, expected.sha256, "pinned owner source mismatch: " + path)
  return blob
}
export function loadOwnerSource(root) {
  const source = {}
  for (const path of Object.keys(manifest.sources)) {
    const bytes = readFileSync(resolve(root, path))
    const blob = verifyOwnerBytes(path, bytes)
    source[path] = bytes.toString("utf8")
    console.log("SOURCE_IDENTITY_PASS " + path + " " + blob)
  }
  return source
}

// Extract top-level original function declarations; keep their entire bodies verbatim.
// Hash gates above freeze the source layout this small extractor is meant to read.
function extract(source, name) {
  const start = new RegExp("^(?:export )?function " + name + "(?:<|\\()", "m").exec(source)?.index
  assert.notEqual(start, undefined, "original function missing: " + name)
  const next = /^(?:export )?function [A-Za-z][A-Za-z0-9_]*(?:<|\()/mg
  next.lastIndex = start + 1
  const end = next.exec(source)?.index ?? source.length
  return source.slice(start, end).replace(/^export /, "")
}
const functions = (source, names) => names.map(name => extract(source, name)).join("\n")
const evaluate = (code, context = {}) => runInNewContext(stripTypeScriptTypes(code), context, {timeout:1000})

export function makeHarness(source) {
  const add = source["packages/cli/src/commands/handlers/mcp/add.ts"]
  const selection = add.match(/^  const mcp =[^\n]*\n  const legacy =[^\n]*\n  const native =[^\n]*\n  const target =[^\n]*\n/m)?.[0]
  assert.ok(selection, "original four selection statements missing")
  const selector = functions(add, ["record","serverConfig"]) +
    "\nfunction select(config: unknown, name: string) {\n" + selection + "\nreturn {legacy,native,target}\n}\nselect"
  const select = evaluate(selector)
  const record = source["packages/ai/src/utils/record.ts"].replace("export const ", "const ")
  const isRecord = evaluate(record + "\nisRecord")
  const normalize = source["packages/core/src/config/normalize.ts"]
  const enabledOnly = evaluate(functions(normalize, ["isEnabledOnlyMcp","own"]) + "\nisEnabledOnlyMcp", {isRecord})
  const migrateMcp = evaluate(functions(source["packages/core/src/v1/config/migrate.ts"], ["migrateMcp"]) + "\nmigrateMcp")
  const names = ["normalizeMcp","normalizeMcpTimeout","decodeMap","isEnabledOnlyMcp","isDirectLegacyMcp","own","setOwn","mergeMaps","conflict","invalid","plain"]

  function normalizeMcp(input) {
    const decodes = []
    // Explicit stand-ins only for valid-local controls. Collision-only checks call zero stand-ins.
    const decode = (_schema, value) => {
      decodes.push(value)
      assert.equal(value.type, "local", "only valid-local controls may use codec stand-ins")
      assert.ok(Array.isArray(value.command))
      assert.ok(value.command.every(item => typeof item === "string"))
      return value
    }
    const fn = evaluate(functions(normalize, names) + "\nnormalizeMcp", {
      isRecord, ConfigMCP:{Server:{}}, ConfigMCPV1:{Info:{}}, ConfigMigrateV1:{migrateMcp},
      decodeEncoded:decode, decodeValue:decode,
      canonical:(_schema,value) => JSON.parse(JSON.stringify(value)),
      isDeepStrictEqual,
    })
    const encoded = {}, diagnostics = []
    fn(input, encoded, diagnostics)
    return {encoded:plain(encoded),diagnostics:plain(diagnostics),codecStandInCalls:decodes.length}
  }
  const plain = value => JSON.parse(JSON.stringify(value))
  return {select:(config,name) => plain(select(config,name)),enabledOnly,normalizeMcp}
}

