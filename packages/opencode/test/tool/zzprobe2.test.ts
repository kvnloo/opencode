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

describe("zzprobe2", () => {
  it.live(
    "matrix2",
    () =>
      Effect.gen(function* () {
        const O = yield* tmpdirScoped()
        const S = "SECRET"
        yield* Effect.promise(async () => {
          const w = (p: string, body: string) => Bun.write(path.join(O, p), body)
          await w("proj/in.txt", "inside")
          await w("proj/sub/in.txt", "inside")
          await w("proj/sub/$-/in.txt", "inside")
          await w("proj/sub/`-/in.txt", "inside")
          await w("proj/$/in.txt", "inside")
          await w("proj/$a/in.txt", "inside")
          await w("proj/`/in.txt", "inside")
          await w("proj/1/in.txt", "inside")
          await w("ext/secret.txt", S)
          await w("ext/secret.txt$", S)
          await w("*/keep", "k")
          await w("proj$", S)
          await w("proj`", S)
          await w("proj(", S)
          await w("proj(x/secret.txt", S)
          await w("proj$x/secret.txt", S)
          await w("proj`x/secret.txt", S)
          await w("proj1/secret.txt", S)
          await w("proj(1", S)
        })
        const list: Array<{ id: string; cmd: string }> = []
        const add = (cmd: string) => list.push({ id: "b" + list.length, cmd })
        // escaped $ / backtick at a word end or before a quote
        for (const e of ["\\$", "\\`"]) {
          const c = e[1]
          add(`cat ${O}/"proj"${e}`)
          add(`cat ${O}/proj${e}`)
          add(`cat ../"proj"${e}`)
          add(`cat ../proj${e}`)
          add(`cat ${O}/"proj"${e}"x/secret.txt"`)
          add(`cat ${O}/proj${e}"x/secret.txt"`)
          add(`cat ${O}/proj${e}'x/secret.txt'`)
          add(`cat "${O}/proj"${e}'x/secret.txt'`)
          add(`cat "${O}/proj"${e}\\x/secret.txt`)
          add(`cat "${O}/proj"${e}/../ext/secret.txt`)
          add(`cat "${O}/proj/"${e}"/../../ext/secret.txt"`)
          add(`cat "${O}/proj/"${e}/../../ext/secret.txt`)
          add(`cat ${O}/proj/${e}/../../ext/secret.txt`)
          add(`cat ${O}/proj/${e}"/../../ext/secret.txt"`)
          add(`cat "${O}/proj/sub/"${e}"-/../../../ext/secret.txt"`)
          add(`cat ${O}/proj/sub/${e}"-"/../../../ext/secret.txt`)
          add(`cat '${O}/proj/'${e}'/../../ext/secret.txt'`)
          add(`cat sub/${e}"-"/../../../ext/secret.txt`)
          add(`cat ./${e}/../../ext/secret.txt`)
          add(`cat ./${e}"/../../ext/secret.txt"`)
          add(`cat ${e}/../../ext/secret.txt`)
          add(`cat ${e}"/../../ext/secret.txt"`)
          add(`cat "${c === "$" ? "\\$" : "\\`"}/../../ext/secret.txt"`)
          add(`cat '${c}/../../ext/secret.txt'`)
          add(`cat '${c}'/../../ext/secret.txt`)
          add(`cat '${c}'"/../../ext/secret.txt"`)
          add(`cat "${O}/ext/secret.txt"${e}`)
          add(`cat ${O}/ext/secret.txt${e}`)
        }
        add(`cat ${O}/proj/$/../../ext/secret.txt`)
        add(`cat ${O}/proj/$"/../../ext/secret.txt"`)
        add(`cat "${O}/proj/$/../../ext/secret.txt"`)
        add(`cat ./$/../../ext/secret.txt`)
        add(`cat $/../../ext/secret.txt`)
        add(`cat "$/../../ext/secret.txt"`)
        add(`cat "$"/../../ext/secret.txt`)
        add(`cat ${O}/proj$`)
        add(`cat "${O}/proj$"`)
        add(`cat "${O}/proj"$`)
        // redirects around args
        add(`cat 2>/dev/null ${O}/ext/secret.txt`)
        add(`cat </dev/null ${O}/ext/secret.txt`)
        add(`cat ${O}/proj/in.txt 2>/dev/null ${O}/ext/secret.txt`)
        add(`2>/dev/null cat ${O}/ext/secret.txt`)
        add(`cat ${O}/ext/secret.txt 2>/dev/null`)
        add(`cat 2>/dev/null ${O}/"proj"\\(x/secret.txt`)
        add(`cat ${O}/"proj"\\(x/secret.txt 2>/dev/null`)
        add(`cat "${O}/proj"\\(x/secret.txt 2>/dev/null`)
        add(`cat "${O}/proj"\\(>/dev/null`)
        add(`cat "${O}/proj"\\(x/secret.txt>/dev/null; cat "${O}/proj"\\(x/secret.txt`)
        add(`cat "${O}/proj"\\( 2>&1 | cat`)
        // prefix assignment, nesting, cd and other commands
        add(`X=1 cat "${O}/proj"\\(x/secret.txt`)
        add(`cat "$(cat "${O}/proj"\\(x/secret.txt)" 2>&1; cat "${O}/proj"\\(`)
        add(`echo "$(cat "${O}/proj"\\(x/secret.txt)"`)
        add(`echo \`cat "${O}/proj"\\(x/secret.txt\``)
        add(`cd "${O}/proj"\\(x && cat secret.txt`)
        add(`cd "${O}/proj/sub/"\\.\\./\\.\\./ext && cat secret.txt`)
        add(`true && cat "${O}/proj"\\(x/secret.txt || true`)
        add(`for f in 1; do cat "${O}/proj"\\(x/secret.txt; done`)
        add(`cat "${O}/proj"\\(x/secret.txt &\nwait`)
        // number pieces
        add(`cat "${O}/proj"\\1/secret.txt`)
        add(`cat "${O}/proj"1/secret.txt`)
        add(`cat "${O}/proj"\\(1`)
        add(`cat "${O}/proj/"\\1/../../ext/secret.txt`)
        add(`cat "${O}/proj/"1/../../ext/secret.txt`)
        add(`cat "${O}/proj/"1"/../../ext/secret.txt"`)
        add(`cat "${O}/proj/"\\.\\./ext/secret.txt 1`)
        // braces: which version stops prompting
        add(`cat ${O}/'*'/../proj/{..,.}/ext/secret.txt`)
        add(`cat ${O}/ext/'*'/../../proj/..{,}/ext/secret.txt`)
        add(`cat ${O}/proj/{..,.}/ext/secret.txt`)
        add(`cat "${O}/proj"\\/{..,.}/ext/secret.txt`)
        add(`cat "${O}/proj/"\\{..,.\\}/ext/secret.txt`)
        // glob after literal-glob
        add(`cat ${O}/'*'/../proj/../e*/secret.txt`)
        add(`cat ${O}/\\*/../proj/../ext/secret.tx?`)
        add(`cat ${O}/'*'/../proj/$U/../ext/secret.txt`)
        add(`cat ${O}/'*'/../proj/~+/../../ext/secret.txt`)
        add(`cat "${O}/*/../proj/.."/ext/secret.txt`)

        const out = yield* Effect.forEach(
          list,
          (item) =>
            runIn(
              path.join(O, "proj"),
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const exit = yield* run({ command: item.cmd }, capture(requests)).pipe(Effect.exit)
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
        yield* Effect.promise(() => Bun.write(process.env.PROBE_OUT!, JSON.stringify({ shell: sh(), n: out.length, out })))
        expect(out.length).toBe(list.length)
      }),
    600_000,
  )
})
