import {
  Client,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  ProtocolError,
  type JSONRPCResponse,
  type McpSubscription,
  type RequestOptions,
  type SubscriptionFilter,
} from "@modelcontextprotocol/client"
import type { RawClientDispatch } from "@modelcontextprotocol/ext-tasks/client"
import { toJsonValue } from "@modelcontextprotocol/ext-tasks/core"
import {
  contributeTaskFilterV2,
  readAcceptedTaskIdsV2,
  withTaskCapabilityV2,
  TaskSubscriptionAcknowledgedNotificationsV2Schema,
  type TaskSubscriptionNotificationsV2,
} from "@modelcontextprotocol/ext-tasks/core/v2"

/** Owns only extension request IDs; the SDK still owns its requests and subscription streams. */
export class TaskClient extends Client {
  private sequence = 0
  private taskListen = false
  private readonly pending = new Map<
    string,
    { respond: (response: JSONRPCResponse) => void; fail: (error: Error) => void }
  >()

  readonly dispatch: RawClientDispatch = (request, options) => {
    const transport = this.transport
    if (!transport) return Promise.reject(new Error("MCP connection closed"))
    if (!request || typeof request !== "object" || Array.isArray(request))
      return Promise.reject(new Error("Expected an MCP extension request"))
    const id = `opencode-task:${this.sequence++}`
    const message = { ...request, jsonrpc: "2.0", id }
    if (!isJSONRPCRequest(message)) return Promise.reject(new Error("Invalid MCP extension request"))
    const controller = new AbortController()
    const timeout = message.method === "tasks/cancel" ? 5_000 : (options?.context?.requestTimeoutMs ?? 30_000)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        options?.signal?.removeEventListener("abort", aborted)
      }
      const fail = (error: Error) => {
        if (!this.pending.has(id)) return
        cleanup()
        controller.abort(error)
        reject(error)
      }
      const aborted = () => fail(new Error("MCP extension request aborted", { cause: options?.signal?.reason }))
      const timer = setTimeout(() => fail(new Error(`MCP extension request timed out: ${message.method}`)), timeout)
      this.pending.set(id, {
        fail,
        respond: (response) => {
          cleanup()
          if (isJSONRPCErrorResponse(response)) {
            resolve({
              kind: "error",
              error: {
                code: response.error.code,
                message: response.error.message,
                ...(response.error.data === undefined ? {} : { data: toJsonValue(response.error.data) }),
              },
            })
            return
          }
          resolve({ kind: "result", result: toJsonValue(response.result) })
        },
      })
      options?.signal?.addEventListener("abort", aborted, { once: true })
      if (options?.signal?.aborted) return aborted()
      try {
        void transport
          .send(message, {
            headers: options?.context?.headers,
            requestSignal: controller.signal,
            onRequestStreamEnd: () =>
              fail(new Error(`MCP extension stream ended without a response: ${message.method}`)),
          })
          .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  override _onresponse(response: JSONRPCResponse) {
    const pending = typeof response.id === "string" ? this.pending.get(response.id) : undefined
    if (pending) return pending.respond(response)
    super._onresponse(response)
  }

  override _onclose() {
    for (const pending of this.pending.values()) pending.fail(new Error("MCP connection closed"))
    super._onclose()
  }

  override _outboundMetaEnvelope() {
    const taskListen = this.taskListen
    // Client 2.3.1 constructs listen metadata synchronously. Consume before transport.send so
    // reentrant ordinary requests cannot accidentally advertise Tasks support.
    this.taskListen = false
    const meta = super._outboundMetaEnvelope()
    return taskListen
      ? (withTaskCapabilityV2({ _meta: toJsonValue(meta ?? {}) })._meta as Readonly<Record<string, unknown>>)
      : meta
  }

  async listenTask(taskId: string, options: RequestOptions): Promise<McpSubscription | undefined> {
    const filter: SubscriptionFilter & TaskSubscriptionNotificationsV2 = {
      ...contributeTaskFilterV2({}, [taskId]).notifications,
      taskIds: [taskId],
    }
    this.taskListen = true
    const opening = super.listen(filter, options)
    this.taskListen = false
    const subscription = await opening.catch((error: unknown) => {
      if (error instanceof ProtocolError && error.code === -32601) return undefined
      throw error
    })
    if (!subscription) return undefined
    const parsed = TaskSubscriptionAcknowledgedNotificationsV2Schema.safeParse(subscription.honoredFilter)
    if (!parsed.success) {
      await subscription.close()
      throw new Error("Malformed MCP Task subscription acknowledgement")
    }
    const accepted = readAcceptedTaskIdsV2({ notifications: subscription.honoredFilter })
    if (accepted.length === 0) {
      await subscription.close()
      return undefined
    }
    if (accepted.length !== 1 || accepted[0] !== taskId) {
      await subscription.close()
      throw new Error(`MCP server did not honor the exact Task subscription filter for ${taskId}`)
    }
    return subscription
  }
}
