import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2"
import {
  activeSubagents,
  recentSubagents,
  subagentActivity,
} from "../../src/feature-plugins/sidebar/subagents"

/**
 * Production sidebar projection — same composition View uses:
 * active rows from activeSubagents + subagentActivity; history from recentSubagents.
 */
function productionSidebarProjection(input: {
  parentMessages: ReadonlyArray<{ id: string }>
  getParts: (messageID: string) => ReadonlyArray<Part>
  getStatus: (sessionID: string) => SessionStatus | undefined
  child: {
    session: (sessionID: string) => { time: { updated: number } } | undefined
    messages: (sessionID: string) => ReadonlyArray<Message>
  }
  historyLimit?: number
}) {
  const active = activeSubagents(input.parentMessages, input.getParts, input.getStatus).map((entry) => ({
    description: entry.description,
    status: entry.status,
    session_id: entry.session_id,
    activity: entry.session_id
      ? subagentActivity(
          input.getStatus(entry.session_id),
          input.child.messages(entry.session_id),
          input.getParts,
        )
      : undefined,
  }))
  const history = recentSubagents(
    input.parentMessages,
    input.getParts,
    input.getStatus,
    input.child,
    input.historyLimit ?? 10,
  )
  return { active, history }
}

/** Pre-fix style: every completed task part, parent order, no activity rank/bound. */
function preFixHistoryProjection(
  messages: ReadonlyArray<{ id: string }>,
  getParts: (messageID: string) => ReadonlyArray<Part>,
) {
  return messages.flatMap((message) =>
    getParts(message.id).flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "task") return []
      if (part.state.status !== "completed" && part.state.status !== "error") return []
      const inputDescription = part.state.input.description
      const title = "title" in part.state ? part.state.title : undefined
      const description =
        typeof inputDescription === "string" ? inputDescription : typeof title === "string" ? title : "Subagent"
      const metadata = "metadata" in part.state ? part.state.metadata : undefined
      const sessionID =
        typeof metadata === "object" &&
        metadata !== null &&
        "sessionId" in metadata &&
        typeof metadata.sessionId === "string"
          ? metadata.sessionId
          : undefined
      if (!sessionID) return []
      return [
        {
          description,
          status: part.state.status === "error" ? ("failed" as const) : ("done" as const),
          session_id: sessionID,
        },
      ]
    }),
  )
}

function taskPart(opts: {
  status: "running" | "completed" | "error"
  description: string
  sessionId: string
  start: number
  end?: number
}): Part {
  if (opts.status === "running") {
    return {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { description: opts.description },
        metadata: { sessionId: opts.sessionId },
        time: { start: opts.start },
      },
    } as unknown as Part
  }
  return {
    type: "tool",
    tool: "task",
    state: {
      status: opts.status === "error" ? "error" : "completed",
      input: { description: opts.description },
      title: opts.description,
      output: "",
      error: opts.status === "error" ? "failed" : undefined,
      metadata: { sessionId: opts.sessionId },
      time: { start: opts.start, end: opts.end ?? opts.start + 1 },
    },
  } as unknown as Part
}

describe("production sidebar projection sequence", () => {
  test("running vs new/stale completed; history bound; newer activity wins; pre-fix negative", () => {
    const parentMessages = [{ id: "assistant-1" }]

    // Sequence: 1 running + 1 newly completed + 1 stale completed,
    // plus older completed peers so historyLimit=2 can prove the bound.
    const parts: Part[] = [
      taskPart({ status: "completed", description: "Stale completed", sessionId: "child-stale", start: 10, end: 20 }),
      taskPart({ status: "completed", description: "Ancient A", sessionId: "child-a", start: 1, end: 2 }),
      taskPart({ status: "completed", description: "Ancient B", sessionId: "child-b", start: 3, end: 4 }),
      taskPart({ status: "completed", description: "Newly completed", sessionId: "child-new", start: 30, end: 40 }),
      taskPart({ status: "running", description: "Running worker", sessionId: "child-run", start: 50 }),
    ]

    const childUpdated: Record<string, number> = {
      "child-stale": 100,
      "child-a": 10,
      "child-b": 20,
      "child-new": 500,
      "child-run": 600,
    }

    const childMessages: Record<string, Message[]> = {
      "child-run": [
        { id: "run-asst-1", role: "assistant", time: { created: 600 } } as unknown as Message,
      ],
      "child-new": [
        { id: "new-asst-1", role: "assistant", time: { created: 400, completed: 500 } } as unknown as Message,
      ],
      "child-stale": [
        { id: "stale-asst-1", role: "assistant", time: { created: 50, completed: 100 } } as unknown as Message,
      ],
    }

    const childParts: Record<string, Part[]> = {
      "run-asst-1": [
        {
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "compile", input: {}, time: { start: 600 } },
        } as unknown as Part,
      ],
    }

    const getStatus = (sessionID: string): SessionStatus | undefined =>
      sessionID === "child-run" ? ({ type: "busy" } as SessionStatus) : undefined

    const getParts = (messageID: string) => {
      if (messageID === "assistant-1") return parts
      return childParts[messageID] ?? []
    }

    const child = {
      session: (sessionID: string) =>
        childUpdated[sessionID] !== undefined ? { time: { updated: childUpdated[sessionID]! } } : undefined,
      messages: (sessionID: string) => childMessages[sessionID] ?? [],
    }

    // 1–2) Production projection: running in active; recent shows new before stale; bound=2
    const first = productionSidebarProjection({
      parentMessages,
      getParts,
      getStatus,
      child,
      historyLimit: 2,
    })

    expect(first.active).toEqual([
      {
        description: "Running worker",
        status: "active",
        session_id: "child-run",
        activity: "bash: compile",
      },
    ])
    expect(first.history).toHaveLength(2)
    expect(first.history.map((row) => row.session_id)).toEqual(["child-new", "child-stale"])
    expect(first.history.some((row) => row.session_id === "child-a")).toBe(false)
    expect(first.history.some((row) => row.session_id === "child-b")).toBe(false)
    expect(first.history.some((row) => row.session_id === "child-run")).toBe(false)

    // 3) Update the running child — newer activity wins over stale completed metadata
    childParts["run-asst-1"] = [
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          title: "compile",
          input: {},
          output: "ok",
          time: { start: 600, end: 650 },
        },
      } as unknown as Part,
      {
        type: "tool",
        tool: "read",
        state: {
          status: "running",
          input: { filePath: "/src/fresh.ts" },
          time: { start: 700 },
        },
      } as unknown as Part,
    ]
    const second = productionSidebarProjection({
      parentMessages,
      getParts,
      getStatus,
      child,
      historyLimit: 2,
    })
    expect(second.active[0]?.activity).toBe("read: /src/fresh.ts")
    expect(second.active[0]?.activity).not.toBe("bash: compile")
    expect(second.history.map((row) => row.session_id)).toEqual(["child-new", "child-stale"])

    // 4) Negative: pre-fix derivation fails the production assertions
    const broken = preFixHistoryProjection(parentMessages, getParts)
    expect(broken.length).toBeGreaterThan(2)
    expect(broken.map((row) => row.session_id)).toEqual([
      "child-stale",
      "child-a",
      "child-b",
      "child-new",
    ])
    expect(broken).not.toHaveLength(2)
    expect(broken.map((row) => row.session_id).slice(0, 2)).not.toEqual(["child-new", "child-stale"])
  })
})
