import assert from "node:assert/strict"
import { resolve } from "node:path"
import { loadOwnerSource, verifyOwnerBytes } from "./source-harness.mjs"
const index=process.argv.indexOf("--repo")
const root=resolve(index===-1 ? process.cwd() : process.argv[index+1])
const source=loadOwnerSource(root)
const path="packages/cli/src/commands/handlers/mcp/add.ts"
assert.throws(() => verifyOwnerBytes(path,Buffer.from(source[path]+"\n")), /pinned owner source mismatch/)
console.log("PASS source identity gate rejects a one-byte in-memory mutation")
console.log("LIMIT no checkout file was mutated")

