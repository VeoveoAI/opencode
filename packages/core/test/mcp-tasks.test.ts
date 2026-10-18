import { expect, test } from "bun:test"
import { isJSONRPCRequest, StreamableHTTPClientTransport, type JSONRPCRequest } from "@modelcontextprotocol/client"
import { Effect, Fiber } from "effect"
import { TaskClient } from "../src/mcp/task-client"
import { McpClient } from "../src/mcp/client"
import { hostEnvironmentLayer } from "./fixture/environment"

const extension = "io.modelcontextprotocol/tasks"
const baseTask = {
  taskId: "generation-1",
  createdAt: "2026-10-17T00:00:00Z",
  lastUpdatedAt: "2026-10-17T00:00:00Z",
  ttlMs: 60_000,
  pollIntervalMs: 60_000,
}
const output = {
  resultType: "complete",
  content: [{ type: "text", text: "generated" }],
  structuredContent: { artifact: "saved" },
}
type Mode =
  | "immediate"
  | "task"
  | "failed"
  | "waiting"
  | "closed"
  | "bad-output"
  | "tool-error"
  | "required-header"
  | "optional-header"
  | "transport-error"
  | "polling"
  | "unsupported-listen"
  | "pending"

function fixture(mode: Mode = "task", ack: unknown = { taskIds: [baseTask.taskId] }) {
  const requests: Array<JSONRPCRequest & { headers: Headers }> = []
  const listening = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const calling = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message: unknown = await request.json()
      if (!isJSONRPCRequest(message)) return new Response(null, { status: 202 })
      requests.push({ ...message, headers: request.headers })
      const result = (value: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result: value })
      if (message.method === "server/discover")
        return result({
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: {}, extensions: { [extension]: {} } },
        })
      if (message.method === "tools/list")
        return result({
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          tools: [
            {
              name: "generate",
              inputSchema: {
                type: "object",
                ...(mode.endsWith("header")
                  ? { properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } }
                  : {}),
              },
              outputSchema: { type: "object", required: ["artifact"], properties: { artifact: { type: "string" } } },
            },
          ],
        })
      if (message.method === "resources/list")
        return result({ resultType: "complete", ttlMs: 0, cacheScope: "private", resources: [] })
      if (message.method === "tools/call") {
        calling.resolve()
        if (mode === "pending")
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
        if (mode === "transport-error") return new Response("offline", { status: 503 })
        if (mode === "required-header")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32021,
              message: "Tasks capability required",
              data: { requiredCapabilities: { extensions: { [extension]: {} } } },
            },
          })
        if (mode === "immediate" || mode === "optional-header") return result(output)
        return result({
          ...baseTask,
          ...(mode === "polling" || mode === "unsupported-listen" ? { pollIntervalMs: 0 } : {}),
          resultType: "task",
          status: "working",
        })
      }
      if (message.method === "tasks/cancel") {
        cancelled.resolve()
        return result({ resultType: "complete" })
      }
      if (message.method === "tasks/get")
        return result({ ...baseTask, resultType: "complete", status: "completed", result: output })
      if (message.method === "subscriptions/listen") {
        if (mode === "unsupported-listen")
          return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
        const stream = new ReadableStream({
          start(controller) {
            const emit = (method: string, params: object) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": message.id } } })}\n\n`,
                ),
              )
            emit("notifications/subscriptions/acknowledged", { notifications: mode === "polling" ? {} : ack })
            listening.resolve()
            if (mode === "closed") {
              emit("notifications/cancelled", { requestId: message.id })
              return
            }
            if (mode === "waiting" || mode === "polling") return
            if (mode === "failed") {
              emit("notifications/tasks", {
                ...baseTask,
                status: "failed",
                error: { code: -32000, message: "provider refused" },
              })
              return
            }
            emit("notifications/tasks", {
              ...baseTask,
              status: "completed",
              result:
                mode === "bad-output"
                  ? { ...output, structuredContent: { artifact: 42 } }
                  : mode === "tool-error"
                    ? { ...output, isError: true, structuredContent: { artifact: 42 } }
                    : output,
            })
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      return result({ resultType: "complete" })
    },
  })
  return {
    requests,
    listening: listening.promise,
    cancelled: cancelled.promise,
    calling: calling.promise,
    url: `http://127.0.0.1:${server.port}/mcp`,
    close: () => server.stop(true),
  }
}

function connected<T>(
  server: ReturnType<typeof fixture>,
  use: (connection: McpClient.Connection) => Effect.Effect<T, Error>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* McpClient.connect(
        "fixture",
        { type: "remote", url: server.url, protocol: "2026-07-28", oauth: false, codemode: false },
        "/",
      )
      return yield* use(connection)
    }),
  ).pipe(Effect.provide(hostEnvironmentLayer))
}

for (const mode of ["immediate", "task"] as const)
  test(`modern ${mode} result preserves structured output without replay`, async () => {
    const server = fixture(mode)
    try {
      const result = await Effect.runPromise(
        connected(server, (connection) => connection.callTool({ name: "generate" })),
      )
      expect(result.structured).toEqual({ artifact: "saved" })
      expect(result.content).toEqual([{ type: "text", text: "generated" }])
      expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
      expect(server.requests.filter((request) => request.method === "tasks/get")).toHaveLength(0)
      const call = server.requests.find((request) => request.method === "tools/call")!
      expect(call.headers.get("mcp-method")).toBe("tools/call")
      expect(call.headers.get("mcp-name")).toBe("generate")
      expect(call.params).toMatchObject({
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: {} } },
        },
      })
      expect(call.params).not.toHaveProperty("task")
    } finally {
      server.close()
    }
  })

for (const [mode, message] of [
  ["failed", "provider refused"],
  ["closed", "subscription closed before completion"],
  ["bad-output", "does not match its schema"],
  ["transport-error", "503"],
] as const)
  test(`${mode} is an error without resubmitting the mutation`, async () => {
    const server = fixture(mode)
    try {
      await expect(
        Effect.runPromise(connected(server, (connection) => connection.callTool({ name: "generate" }))),
      ).rejects.toThrow(message)
      expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
    } finally {
      server.close()
    }
  })

test("tool isError remains a tool result even when its diagnostic output differs from the success schema", async () => {
  const server = fixture("tool-error")
  try {
    expect(
      (await Effect.runPromise(connected(server, (connection) => connection.callTool({ name: "generate" })))).isError,
    ).toBe(true)
  } finally {
    server.close()
  }
})

for (const ack of [{ taskIds: ["other"] }, { taskIds: [baseTask.taskId, "other"] }, { taskIds: [42] }])
  test(`Task subscription refuses nonexact acknowledgement ${JSON.stringify(ack)}`, async () => {
    const server = fixture("waiting", ack)
    try {
      await expect(
        Effect.runPromise(connected(server, (connection) => connection.callTool({ name: "generate" }))),
      ).rejects.toThrow(
        ack.taskIds.some((id) => typeof id !== "string")
          ? "Malformed MCP Task subscription acknowledgement"
          : "did not honor the exact Task subscription filter",
      )
      expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
    } finally {
      server.close()
    }
  })

test("user interruption sends a bounded remote cancel on an uncancelled request", async () => {
  const server = fixture("waiting")
  try {
    await Effect.runPromise(
      connected(server, (connection) =>
        Effect.gen(function* () {
          const call = yield* Effect.forkChild(connection.callTool({ name: "generate" }))
          yield* Effect.promise(() => server.listening)
          yield* Fiber.interrupt(call)
          yield* Effect.promise(() => server.cancelled)
        }),
      ),
    )
    const cancel = server.requests.filter((request) => request.method === "tasks/cancel")
    expect(cancel).toHaveLength(1)
    expect(cancel[0].headers.get("mcp-name")).toBe(baseTask.taskId)
    expect(cancel[0].headers.get("mcp-method")).toBe("tasks/cancel")
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
  } finally {
    server.close()
  }
})

test("annotated tools stay on the SDK path without replay when the server requires Tasks", async () => {
  const required = fixture("required-header")
  try {
    await expect(
      Effect.runPromise(
        connected(required, (connection) => connection.callTool({ name: "generate", args: { tenant: "local" } })),
      ),
    ).rejects.toThrow(
      "Tasks capability required; upstream MCP SDK cannot combine x-mcp-header projection with Task execution",
    )
    expect(required.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
    const call = required.requests.find((request) => request.method === "tools/call")!
    expect(call.headers.get("mcp-param-tenant")).toBe("local")
    expect(call.params).not.toMatchObject({
      _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: {} } } },
    })
  } finally {
    required.close()
  }
  const optional = fixture("optional-header")
  try {
    await Effect.runPromise(
      connected(optional, (connection) => connection.callTool({ name: "generate", args: { tenant: "local" } })),
    )
    const call = optional.requests.find((request) => request.method === "tools/call")!
    expect(call.headers.get("mcp-param-tenant")).toBe("local")
    expect(call.params).not.toMatchObject({
      _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: {} } } },
    })
  } finally {
    optional.close()
  }
})

for (const mode of ["polling", "unsupported-listen"] as const)
  test(`${mode} server completes through official Task polling without mutation replay`, async () => {
    const server = fixture(mode)
    try {
      expect(
        (await Effect.runPromise(connected(server, (connection) => connection.callTool({ name: "generate" }))))
          .structured,
      ).toEqual({ artifact: "saved" })
      expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
      const get = server.requests.find((request) => request.method === "tasks/get")!
      expect(get.headers.get("mcp-method")).toBe("tasks/get")
      expect(get.headers.get("mcp-name")).toBe(baseTask.taskId)
    } finally {
      server.close()
    }
  })

test("SDK subscription codec preserves unknown extensions and refuses invalid known fields", async () => {
  for (const filter of [
    { taskIds: [baseTask.taskId], "example/filter": { value: true } },
    { toolsListChanged: "invalid" },
  ]) {
    const server = fixture("waiting", filter)
    const client = new TaskClient(
      { name: "test", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    )
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
      if ("toolsListChanged" in filter) {
        await expect(client.listenTask(baseTask.taskId, {})).rejects.toThrow(
          "Invalid subscriptions/listen acknowledgement",
        )
        continue
      }
      const subscription = await client.listenTask(baseTask.taskId, {})
      expect(subscription?.honoredFilter).toEqual(filter)
      await subscription?.close()
    } finally {
      await client.close()
      server.close()
    }
  }
})

test("ordinary, raw Task, and SDK subscription IDs and capabilities remain independent concurrently", async () => {
  const server = fixture("task")
  try {
    await Effect.runPromise(
      connected(server, (connection) =>
        Effect.all([connection.resources(), connection.callTool({ name: "generate" })], { concurrency: "unbounded" }),
      ),
    )
    const ordinary = server.requests.find((request) => request.method === "resources/list")!
    const raw = server.requests.find((request) => request.method === "tools/call")!
    const listen = server.requests.find((request) => request.method === "subscriptions/listen")!
    expect(typeof ordinary.id).toBe("number")
    expect(raw.id).toMatch(/^opencode-task:/)
    expect(listen.id).toMatch(/^listen:/)
    expect(new Set(server.requests.map((request) => request.id)).size).toBe(server.requests.length)
    expect(ordinary.params).not.toMatchObject({
      _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: {} } } },
    })
    for (const request of [raw, listen])
      expect(request.params).toMatchObject({
        _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [extension]: {} } } },
      })
  } finally {
    server.close()
  }
})

test("connection close settles an in-flight raw request without replay", async () => {
  const server = fixture("pending")
  const client = new TaskClient(
    { name: "test", version: "1" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    const pending = client.dispatch({ method: "tools/call", params: { name: "generate" } })
    const rejected = pending.catch((error: unknown) => error)
    await server.calling
    await client.close()
    expect(await rejected).toMatchObject({ message: "MCP connection closed" })
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
  } finally {
    await client.close()
    server.close()
  }
})

test("only official Task execution has a hard wall, with bounded remote cancellation and no replay", async () => {
  const server = fixture("waiting")
  try {
    const result = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* McpClient.connect(
          "fixture",
          {
            type: "remote",
            url: server.url,
            protocol: "2026-07-28",
            oauth: false,
            codemode: false,
            timeout: { execution: 25 },
          },
          "/",
        )
        return yield* connection.callTool({ name: "generate" })
      }),
    ).pipe(Effect.provide(hostEnvironmentLayer))
    await expect(Effect.runPromise(result)).rejects.toThrow("MCP tool execution timed out after 25ms")
    expect(server.requests.filter((request) => request.method === "tasks/cancel")).toHaveLength(1)
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(1)
  } finally {
    server.close()
  }
})
