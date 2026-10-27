import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

// ---- independent verifier probe (uncommitted) ----
const PUNCT = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter((c) => !/[A-Za-z0-9]/.test(c))
const CH = [...PUNCT, "\t"]
const D2 = ["(", "@", " ", "$", "*", "\\", "'", '"', "`"]
const code = (c: string) => c.charCodeAt(0).toString(16).padStart(2, "0")

describe("zzprobe", () => {
  it.live(
    "matrix",
    () =>
      Effect.gen(function* () {
        const O = yield* tmpdirScoped()
        const S = "SECRET"
        const user = os.userInfo().username
        yield* Effect.promise(async () => {
          const w = (p: string, body: string) => Bun.write(path.join(O, p), body)
          await w("proj/in.txt", "inside")
          await w("proj/sub/in.txt", "inside")
          await w("proj/sub/deep/deeper/in.txt", "inside")
          await w("proj/$/in.txt", "inside")
          await w("proj/~/in.txt", "inside")
          await w("ext/secret.txt", S)
          await w("projx/secret.txt", S)
          await w("*/keep", "k")
          await w("[/keep", "k")
          await w("?/keep", "k")
          await w("ext/*/keep", "k")
          await w("proj\u{1F600}x/secret.txt", S)
          await w("proj/sub/\u{1F600}-/in.txt", "inside")
          for (const c of CH) {
            if (c === "/") continue
            await w(`proj${c}`, S)
            await w(`proj${c}x/secret.txt`, S)
            await w(`proj${c} x/secret.txt`, S)
            await w(`proj/sub/${c}-/in.txt`, "inside")
            await w(`proj/${c}a/in.txt`, "inside")
            for (const d of D2) await w(`proj${c}${d}x/secret.txt`, S)
          }
        })
        const list: Array<{ id: string; cmd: string; workdir?: string }> = []
        const add = (id: string, cmd: string, workdir?: string) => list.push({ id, cmd, workdir })
        for (const c of CH) {
          const k = code(c)
          const E = "\\" + c
          const Q = c === "'" ? `"'"` : `'${c}'`
          const D = '"' + (["$", "`", '"', "\\"].includes(c) ? "\\" + c : c) + '"'
          const A = "$'" + (c === "'" || c === "\\" ? "\\" + c : c) + "'"
          const HX = `$'\\x${k}'`
          if (c !== "/") {
            add(`dq-esc:${k}`, `cat "${O}/proj"${E}x/secret.txt`)
            add(`sq-esc:${k}`, `cat '${O}/proj'${E}x/secret.txt`)
            add(`un-esc:${k}`, `cat ${O}/proj${E}x/secret.txt`)
            add(`mix-esc:${k}`, `cat ${O}/"proj"${E}x/secret.txt`)
            add(`dq-sq:${k}`, `cat "${O}/proj"${Q}x/secret.txt`)
            add(`dq-dq:${k}`, `cat "${O}/proj"${D}x/secret.txt`)
            add(`sq-dq:${k}`, `cat '${O}/proj'${D}x/secret.txt`)
            add(`sq-sq:${k}`, `cat '${O}/proj'${Q}x/secret.txt`)
            add(`esc-dqtail:${k}`, `cat "${O}/proj"${E}"x/secret.txt"`)
            add(`esc-sqmid:${k}`, `cat "${O}/proj"${E}'x'/secret.txt`)
            add(`empty-esc:${k}`, `cat "${O}/proj"''${E}x/secret.txt`)
            add(`esc-empty:${k}`, `cat "${O}/proj"${E}""x/secret.txt`)
            add(`esc-var:${k}`, `cat "${O}/proj"${E}$U"x/secret.txt"`)
            add(`esc-var2:${k}`, `cat '${O}/proj'${E}\${U}x/secret.txt`)
            add(`esc-glob:${k}`, `cat "${O}/proj"${E}?/secret.txt`)
            add(`esc-sub:${k}`, `cat "${O}/proj"${E}$(echo x)/secret.txt`)
            add(`esc-bt:${k}`, `cat "${O}/proj"${E}\`echo x\`/secret.txt`)
            add(`var-esc:${k}`, `cat "${O}/proj"$U${E}x/secret.txt`)
            add(`esc-sp:${k}`, `cat "${O}/proj"${E}\\ x/secret.txt`)
            for (const d of D2) add(`two-dq:${k}:${code(d)}`, `cat "${O}/proj"${E}\\${d}x/secret.txt`)
            for (const d of ["(", "@", "$"]) add(`two-sq:${k}:${code(d)}`, `cat '${O}/proj'${E}\\${d}x/secret.txt`)
            for (const d of ["(", "*"]) add(`two-un:${k}:${code(d)}`, `cat ${O}/proj${E}\\${d}x/secret.txt`)
            add(`ansi-head:${k}`, `cat $'${O}/proj'${E}x/secret.txt`)
            add(`ansi-c:${k}`, `cat "${O}/proj"${A}x/secret.txt`)
            add(`ansi-hex:${k}`, `cat "${O}/proj"${HX}x/secret.txt`)
            add(`esc-ansi:${k}`, `cat "${O}/proj"${E}$'x'/secret.txt`)
            add(`climb-sub-dq:${k}`, `cat "${O}/proj/sub/"${E}-/../../../ext/secret.txt`)
            add(`climb-sub-sq:${k}`, `cat '${O}/proj/sub/'${E}-/../../../ext/secret.txt`)
            add(`climb-sub-un:${k}`, `cat ${O}/proj/sub/${E}-/../../../ext/secret.txt`)
            add(`climb-root-dq:${k}`, `cat "${O}/proj/"${E}a/../../ext/secret.txt`)
            add(`climb-root-sq:${k}`, `cat '${O}/proj/'${E}a/../../ext/secret.txt`)
            add(`climb-root-un:${k}`, `cat ${O}/proj/${E}a/../../ext/secret.txt`)
            add(`climb-rel:${k}`, `cat "sub/"${E}-/../../../ext/secret.txt`)
            add(`nl-before:${k}`, `cat "${O}/proj"\\\n${E}x/secret.txt`)
            add(`nl-after:${k}`, `cat "${O}/proj"${E}\\\nx/secret.txt`)
            add(`brace:${k}`, `cat "${O}/proj"${E}{x,x}/secret.txt`)
            add(`rel1:${k}`, `cat ../"proj"${E}x/secret.txt`)
            add(`rel2:${k}`, `cat ''\\../proj${E}x/secret.txt`)
            add(`wordend-dq:${k}`, `cat "${O}/proj"${E}`)
            add(`wordend-sq:${k}`, `cat '${O}/proj'${E}`)
            add(`wordend-seq:${k}`, `cat "${O}/proj"${E}; echo hi`)
            add(`wordend-two:${k}`, `cat "${O}/proj"${E} ${O}/proj/in.txt`)
            add(`wordend-var:${k}`, `cat "${O}/proj"$U${E}`)
            add(`wordend-escvar:${k}`, `cat "${O}/proj"${E}$U`)
            add(`three:${k}`, `cat "${O}/pr"\\oj${Q}\\x/secret.txt`)
            add(`three2:${k}`, `cat '${O}/proj'${E}'x'\\/'..'\\/ext/secret.txt`)
          }
          if ("!#%+,-.:=@^_{}~]".includes(c)) add(`raw:${k}`, `cat "${O}/proj"${c}x/secret.txt`)
        }
        // the eight named spellings
        add("F1", `cat ${O}/"proj"\\(x/secret.txt`)
        add("F2", `cat "${O}/proj/sub/"\\(-/../../../ext/secret.txt`)
        add("F3", `cat "${O}/proj/"\\(a/../../ext/secret.txt`)
        add("F4", `cat "${O}/proj"\\(`)
        add("F5", `cat "${O}/proj"\\(x/secret.txt`)
        add("F6", `cat '${O}/proj'\\(x/secret.txt`)
        add("F7", `cat "${O}/proj"\\@\\(x/secret.txt`)
        add("F8", `cat "${O}/proj"\\(\\ x/secret.txt`)
        // manual
        add("m-slash1", `cat "${O}/proj"\\/../ext/secret.txt`)
        add("m-slash2", `cat "${O}/proj/"\\../ext/secret.txt`)
        add("m-slash3", `cat "${O}/proj/"\\.\\./ext/secret.txt`)
        add("m-nl1", `cat ${O}/proj/\\\n../ext/secret.txt`)
        add("m-nl2", `cat "${O}/proj/.\\\n./ext/secret.txt"`)
        add("m-nl3", `cat '${O}/proj/'\\\n'../ext/secret.txt'`)
        add("m-nl4", `cat "${O}/proj/".\\\n./ext/secret.txt`)
        add("m-nl5", `cat "${O}/proj"\\\nx/secret.txt`)
        add("m-nl6", `cat "${O}/proj"\\\n/../ext/secret.txt`)
        add("m-nl7", `cat "${O}/proj"\\\n\\\n\\(x/secret.txt`)
        add("m-nl8", `cat "${O}/proj/"\\\n\\.\\\n./ext/secret.txt`)
        add("m-nl9", `cat "${O}/proj/"\\\n"../ext/secret.txt"`)
        add("m-nl10", `cat '${O}/proj/..'\\\n/ext/secret.txt`)
        add("m-empty1", `cat ""\\../ext/secret.txt`)
        add("m-empty2", `cat ''\\../ext/secret.txt`)
        add("m-var1", `cat $U\\../ext/secret.txt`)
        add("m-var2", `cat "$U"\\../ext/secret.txt`)
        add("m-var3", `cat $U"${O}/ext"\\/secret.txt`)
        add("m-var4", `cat \${U}\\../ext/secret.txt`)
        add("m-var5", `cat $(echo)\\../ext/secret.txt`)
        add("m-dollar1", `cat ${O}/proj/$/../../ext/secret.txt`)
        add("m-dollar2", `cat '${O}/proj$x/secret.txt'`)
        add("m-dollar3", `cat ${O}/ext/$U/secret.txt`)
        add("m-w1", `cat ${O}/proj$U/../ext/secret.txt`)
        add("m-w2", `cat ${O}/proj/*/../../ext/secret.txt`)
        add("m-w3", `cat "${O}/proj"\\ x/secret.txt$unset`)
        add("m-w4", `cat "${O}/proj"\\ $U"x/secret.txt"`)
        add("m-br1", `cat ${O}/proj/{..,.}/ext/secret.txt`)
        add("m-br2", `cat ${O}/'*'/../proj/{..,.}/ext/secret.txt`)
        add("m-br3", `cat ${O}/\\*/../proj/{..,.}/ext/secret.txt`)
        add("m-br4", `cat "${O}/*/../proj/"{..,.}/ext/secret.txt`)
        add("m-br5", `cat ${O}/{proj/..,proj}/ext/secret.txt`)
        add("m-br6", `cat ${O}/{ext,proj}/secret.txt`)
        add("m-br7", `cat ${O}/proj/{.,}./ext/secret.txt`)
        add("m-br8", `cat "${O}/proj/"{..,.}"/ext/secret.txt"`)
        add("m-br9", `cat ${O}/proj/..{,}/ext/secret.txt`)
        add("m-br10", `cat ${O}/'['/../proj/{..,.}/ext/secret.txt`)
        add("m-br11", `cat ${O}/'?'/../proj/..{,}/ext/secret.txt`)
        add("m-br12", `cat "${O}/proj"\\({x,x}/secret.txt`)
        add("m-br13", `cat "${O}/proj/"{..,..}\\/ext/secret.txt`)
        add("m-br14", `cat "${O}/ext/*"/../../proj/{..,.}/ext/secret.txt`)
        add("m-br15", `cat ${O}/ext/\\*/../../proj/..{,}/ext/secret.txt`)
        add("m-br16", `cat '${O}/proj'/{..,.}/ext/secret.txt`)
        add("m-br17", `cat "${O}/proj"\\/{..,.}/ext/secret.txt`)
        add("m-ti1", `cat ~+/../ext/secret.txt`)
        add("m-ti2", `cat ~-/../ext/secret.txt`)
        add("m-ti3", `cat ~/../..${O}/ext/secret.txt`)
        add("m-ti4", `cat "~"/../..${O}/ext/secret.txt`)
        add("m-ti5", `cat \\~/../../ext/secret.txt`)
        add("m-ti6", `cat ~"/../.."${O}/ext/secret.txt`)
        add("m-ti7", `cat ~${user}/../..${O}/ext/secret.txt`)
        add("m-ti8", `cat "~/../../ext/secret.txt"`)
        add("m-ti9", `cat '~'/../../ext/secret.txt`)
        add("m-ti10", `cat ~\\/../../ext/secret.txt`)
        add("m-ti11", `cat ~+/'*'/../../ext/secret.txt`)
        add("m-ti12", `cat ""~/../../ext/secret.txt`)
        add("m-ti13", `cat ~""/../../ext/secret.txt`)
        add("m-ti14", `cat "${O}/proj"\\~x/secret.txt`)
        add("m-ti15", `cat ~+"/../ext"\\/secret.txt`)
        add("m-as1", `cat "${O}/proj"\\\u{1F600}x/secret.txt`)
        add("m-as2", `cat "${O}/proj/sub/"\\\u{1F600}-/../../../ext/secret.txt`)
        add("m-as3", `cat "${O}/proj/sub/"\\\u{1F600}-/../../../ext/secret.txt`, path.join(O, "proj/sub/deep/deeper"))
        add("m-as4", `echo \u00e9\u{1F600}; cat "${O}/proj"\\(x/secret.txt`)
        add("m-as5", `echo \u00e9\u{1F600}; cat "${O}/proj/sub/"\\(-/../../../ext/secret.txt`)
        add("m-as6", `cat "${O}/proj\u{1F600}"\\x/secret.txt`)
        add("m-mc1", `cat "${O}/proj"\\(x/secret.txt; echo done`)
        add("m-mc2", `cat "${O}/proj"\\( && echo ok`)
        add("m-mc3", `echo $(cat "${O}/proj"\\(x/secret.txt)`)
        add("m-mc4", `cat "${O}/proj"\\(x/secret.txt | head -1`)
        add("m-mc5", `cat "${O}/proj"\\(x/secret.txt 2>&1`)
        add("m-mc6", `cat 2>/dev/null "${O}/proj"\\(x/secret.txt`)
        add("m-mc7", `cat "${O}/proj"\\( 2>/dev/null`)
        add("m-mc8", `cat "${O}/proj"\\(>/dev/null; cat "${O}/proj"\\(`)
        add("m-mc9", `echo "$(cat "${O}/proj"\\()"`)
        add("m-mc10", `cat "${O}/proj"\\(\n`)
        add("m-mc11", `cat "${O}/proj"\\(\necho hi`)
        add("m-mc12", `cat "${O}/proj"\\(|head -1`)
        add("m-mc13", `cat "${O}/proj"\\(&&echo ok`)
        add("m-mc14", `(cat "${O}/proj"\\()`)
        add("m-mc15", `{ cat "${O}/proj"\\(; }`)
        add("m-mc16", `if true; then cat "${O}/proj"\\(; fi`)
        add("m-mc17", `cat "${O}/proj"\\(x/secret.txt "${O}/proj/in.txt"`)
        add("m-mc18", `cat "${O}/proj/in.txt" "${O}/proj"\\(x/secret.txt`)
        add("m-mc19", `cat -- "${O}/proj"\\(x/secret.txt`)
        add("m-mc20", `cat "${O}/proj"\\(#x`)
        add("m-p1", `cat "${O}"\\/"proj"\\("x"\\/secret.txt`)
        add("m-p2", `cat "${O}/proj"\\("x"\\/"secret.txt"`)
        add("m-p3", `cat "${O}/proj/sub/"\\("-"\\/../../../ext/secret.txt`)
        add("m-p4", `cat "${O}/proj/sub/"\\(-"/../../../ext/secret.txt"`)
        add("m-p5", `cat "${O}/proj/sub/"\\(-/'../../..'/ext/secret.txt`)
        add("m-p6", `cat "${O}/proj/sub"\\/\\(\\-\\/\\.\\./../../ext/secret.txt`)
        add("m-p7", `cat "${O}/proj/"\\(a/..\\/../ext/secret.txt`)
        add("m-p8", `cat "${O}/proj/"\\(a/".."/"../ext/secret.txt"`)
        add("m-p9", `cat "${O}/proj/"\\(a"/../.."\\/ext\\/secret.txt`)
        add("m-p10", `cat "${O}/proj/"'(a'"/../.."/ext/secret.txt`)
        add("m-p11", `cat "${O}/proj/""(a/../../ext/secret.txt"`)
        add("m-p12", `cat "${O}/proj/"'(a/../../ext/secret.txt'`)
        add("m-p13", `cat "${O}/proj/"\\(a/../../ext/secret.tx?`)
        add("m-p14", `cat "${O}/proj/"\\(a/../../e*/secret.txt`)
        add("m-p15", `cat "${O}/proj/"\\(a/../../ext/"secret.txt"$U`)
        add("m-base", `cat ${O}/ext/secret.txt`)
        add("m-in", `cat ${O}/proj/in.txt`)

        const out = yield* Effect.forEach(
          list,
          (item) =>
            runIn(
              path.join(O, "proj"),
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const exit = yield* run(
                  { command: item.cmd, ...(item.workdir ? { workdir: item.workdir } : {}) },
                  capture(requests),
                ).pipe(Effect.exit)
                const patterns = requests
                  .filter((r) => r.permission === "external_directory")
                  .flatMap((r) => r.patterns)
                  .map((p) => p.replaceAll(O, "<O>"))
                return {
                  id: item.id,
                  cmd: item.cmd.replaceAll(O, "<O>"),
                  prompt: patterns.length > 0,
                  patterns,
                  secret: Exit.isSuccess(exit) ? exit.value.output.includes(S) : false,
                  err: Exit.isSuccess(exit) ? undefined : String(Cause.squash(exit.cause)).slice(0, 200),
                }
              }),
            ),
          { concurrency: 8 },
        )
        yield* Effect.promise(() =>
          Bun.write(process.env.PROBE_OUT!, JSON.stringify({ shell: sh(), n: out.length, out }, null, 0)),
        )
        expect(out.length).toBe(list.length)
      }),
    600_000,
  )
})
