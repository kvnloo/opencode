import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadOwnerSource, makeHarness } from "./source-harness.mjs"

const value = name => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const mode = value("--mode") ?? "observations"
assert.ok(["observations","preservation-red"].includes(mode), "choose --mode observations or preservation-red")
const root = resolve(value("--repo") ?? process.cwd())
const {select,enabledOnly,normalizeMcp} = makeHarness(loadOwnerSource(root))
const local = {type:"local",command:["gh","mcp"]}
const probe = {type:"local",command:["echo","ok"]}
const remote = {type:"remote",url:"https://example.invalid/mcp"}
let passed = 0, failed = 0
function check(name, fn) {
  try { fn();passed++;console.log("PASS " + name) }
  catch (error) {
    failed++
    console.log("RED " + name)
    if (error.actual !== undefined) console.log("  actual=" + JSON.stringify(error.actual))
    if (error.expected !== undefined) console.log("  expected=" + JSON.stringify(error.expected))
    if (error.actual === undefined) console.log("  assertion=" + error.message.split("\n")[0])
  }
}
if (mode === "preservation-red") {
  const frozen = JSON.parse(readFileSync(new URL("./preservation-cases.json",import.meta.url),"utf8"))
  for (const item of frozen.cases)
    check("conditional owner-preservation target: " + item.name, () => {
      assert.deepEqual(select(item.config,item.serverName).target,item.expectedTarget)
    })
} else {
  const cases = [
    ["missing mcp",{}, "probe",false,false,["mcp","servers","probe"]],
    ["empty mcp",{mcp:{}}, "probe",false,false,["mcp","servers","probe"]],
    ["empty native servers",{mcp:{servers:{}}}, "probe",false,true,["mcp","servers","probe"]],
    ["typed legacy local",{mcp:{github:local}}, "probe",true,false,["mcp","probe"]],
    ["typed legacy remote",{mcp:{remote}}, "probe",true,false,["mcp","probe"]],
    ["native typed map",{mcp:{servers:{github:local}}}, "probe",false,true,["mcp","servers","probe"]],
    ["mixed map",{mcp:{github:local,servers:{remote}}}, "probe",true,true,["mcp","servers","probe"]],
    ["typed legacy name servers",{mcp:{servers:local}}, "probe",true,false,["mcp","probe"]],
    ["add name servers to typed legacy",{mcp:{github:local}}, "servers",true,false,["mcp","servers"]],
    ["native name servers",{mcp:{servers:{servers:local}}}, "probe",false,true,["mcp","servers","probe"]],
    ["typed legacy name timeout",{mcp:{timeout:remote}}, "probe",true,false,["mcp","probe"]],
    ["native timeout only",{mcp:{timeout:{startup:1000}}}, "probe",false,false,["mcp","servers","probe"]],
    ["enabled-only ordinary sibling beside typed legacy",{mcp:{github:local,off:{enabled:false}}}, "probe",true,false,["mcp","probe"]],
    ["observed enabled-only ordinary gap",{mcp:{github:{enabled:false}}}, "probe",false,false,["mcp","servers","probe"]],
    ["observed enabled-only servers with typed sibling",{mcp:{github:local,servers:{enabled:false}}}, "probe",true,true,["mcp","servers","probe"]],
    ["observed enabled-only servers alone",{mcp:{servers:{enabled:false}}}, "probe",false,true,["mcp","servers","probe"]],
  ]
  for (const [name,config,serverName,legacy,native,target] of cases)
    check("selector: " + name, () => {
      const before = structuredClone(config)
      assert.deepEqual(select(config,serverName),{legacy,native,target})
      assert.deepEqual(config,before)
    })
  check("original enabled-only predicate: typed disabled server differs from override", () => {
    assert.equal(enabledOnly({...local,enabled:false}),false)
    assert.equal(enabledOnly({enabled:false}),true)
  })
  check("plain-object selected-target simulation keeps typed sibling and enabled-only predicate", () => {
    const config={mcp:{github:structuredClone(local),servers:{enabled:false}}}
    assert.deepEqual(select(config,"probe").target,["mcp","servers","probe"])
    // Target simulation only; no JSONC parser or writer is invoked.
    config.mcp.servers.probe=probe
    assert.equal(enabledOnly(config.mcp.servers),true)
    assert.deepEqual(config.mcp.github,local)
  })
  check("exact normalizer collision enabled=false: zero codec stand-in calls", () => {
    const out=normalizeMcp({mcp:{servers:{enabled:false,probe}}})
    assert.deepEqual(out.encoded,{})
    assert.equal(out.codecStandInCalls,0)
    assert.deepEqual(out.diagnostics,[{kind:"unsupported",path:["mcp","servers"],message:"omitted enabled-only legacy MCP entry"}])
  })
  check("exact normalizer collision enabled=true: zero codec stand-in calls", () => {
    const out=normalizeMcp({mcp:{servers:{enabled:true,probe}}})
    assert.deepEqual(out.encoded,{})
    assert.equal(out.codecStandInCalls,0)
  })
  check("normalizer valid-local codec control: native map retains probe", () => {
    const out=normalizeMcp({mcp:{servers:{probe}}})
    assert.deepEqual(out.encoded,{mcp:{servers:{probe}}})
    assert.equal(out.codecStandInCalls,1)
    assert.deepEqual(out.diagnostics,[])
  })
  check("normalizer valid-local codec control: typed sibling survives; nested probe omitted", () => {
    const out=normalizeMcp({mcp:{github:local,servers:{enabled:false,probe}}})
    assert.deepEqual(out.encoded,{mcp:{servers:{github:local}}})
    assert.equal(out.codecStandInCalls,1)
    assert.equal(out.diagnostics.length,1)
  })
  check("normalizer valid-local codec control: ordinary override omitted; native probe survives", () => {
    const out=normalizeMcp({mcp:{github:{enabled:false},servers:{probe}}})
    assert.deepEqual(out.encoded,{mcp:{servers:{probe}}})
    assert.equal(out.codecStandInCalls,1)
    assert.equal(out.diagnostics.length,1)
  })
  check("normalizer valid-local codec control: typed name servers and flat probe survive", () => {
    const out=normalizeMcp({mcp:{servers:local,probe}})
    assert.deepEqual(out.encoded,{mcp:{servers:{servers:local,probe}}})
    assert.equal(out.codecStandInCalls,2)
    assert.deepEqual(out.diagnostics,[])
  })
}
console.log("RESULT mode=" + mode + " passed=" + passed + " failed=" + failed)
console.log("LIMIT extracted source only; JSONC writer, full schema and CLI were not run")
process.exitCode=failed ? 1 : 0

