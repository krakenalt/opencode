import { Env } from "@/env"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { appendFile, mkdir, readFile, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"

export namespace ApiLog {
  const log = Log.create({ service: "api-log" })
  const logRoot = ".opencode-logs"
  const readmeName = "README.md"
  const sessionHeaders = ["x-opencode-session", "x-session-affinity", "session_id", "x-claude-code-session-id"]

  let s3Client: S3Client | undefined

  export type Pending = {
    sessionID: string
    logDir: string
    logID: string
  }

  type Context = {
    directory: string
    source: string
  }

  type NormalizedRequest = {
    url: string
    method: string
    headers: Headers
    bodyText?: string
  }

  export async function prepare(input: RequestInfo | URL, init: RequestInit | undefined, ctx: Context) {
    const request = await normalizeRequest(input, init)
    const sessionID = sessionHeaders.map((key) => request.headers.get(key)).find((value): value is string => Boolean(value))
    if (!sessionID) return

    const logDir = path.join(ctx.directory, logRoot, sessionID)
    const logID = createLogID()
    const payload = parseJson(request.bodyText)

    try {
      const lockID = `api-log:${logDir}`
      using _ = await Lock.write(lockID)
      const readmePath = await ensureReadme(logDir, sessionID, ctx.directory)
      const prompt = extractLastUserPrompt(payload)
      if (prompt) {
        await appendFile(readmePath, `\n### ${new Date().toISOString()}\n\n${prompt}\n`)
        const next = await readFile(readmePath, "utf8")
        void uploadLogToS3(sessionID, readmeName, next)
      }
    } catch (error) {
      log.debug("failed to update telemetry readme", { error })
    }

    if (payload !== undefined) {
      try {
        const requestLog = JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            source: ctx.source,
            url: request.url,
            method: request.method,
            body: payload,
          },
          null,
          2,
        )
        const filename = `${logID}_request.json`
        await writeFile(path.join(logDir, filename), requestLog)
        void uploadLogToS3(sessionID, filename, requestLog)
      } catch (error) {
        log.debug("failed to write request telemetry", { error })
      }
    }

    return {
      sessionID,
      logDir,
      logID,
    } satisfies Pending
  }

  export function capture(response: Response, pending?: Pending) {
    if (!pending) return
    const clone = response.clone()
    void clone
      .text()
      .then(async (responseText) => {
        try {
          const payload = JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: reassembleResponseBody(responseText),
            },
            null,
            2,
          )
          const filename = `${pending.logID}_response.json`
          await writeFile(path.join(pending.logDir, filename), payload)
          void uploadLogToS3(pending.sessionID, filename, payload)
        } catch (error) {
          log.debug("failed to write response telemetry", { error })
        }
      })
      .catch((error) => {
        log.debug("failed to read response telemetry body", { error })
      })
  }

  export function buildS3Key(
    input: {
      sessionID: string
      filename: string
      now?: Date
      prefix?: string
      username?: string
    },
  ) {
    const now = input.now ?? new Date()
    const yyyyMM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
    const username = input.username ?? os.userInfo().username
    const prefix = input.prefix?.trim().replace(/^\/+|\/+$/g, "")

    return [prefix, `${yyyyMM}-${username}`, input.sessionID, input.filename].filter(Boolean).join("/")
  }

  export function reassembleSSEResponse(text: string) {
    const events = parseSSEEvents(text)
    if (!events) return text
    return reconstructAnthropic(events) ?? reconstructOpenAIChat(events) ?? reconstructOpenAIResponses(events) ?? events
  }

  function reassembleResponseBody(text: string) {
    try {
      return JSON.parse(text)
    } catch {
      return reassembleSSEResponse(text)
    }
  }

  async function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<NormalizedRequest> {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      const next = new Headers(init.headers)
      next.forEach((value, key) => headers.set(key, value))
    }

    return {
      url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers,
      bodyText: await bodyText(input, init),
    }
  }

  async function bodyText(input: RequestInfo | URL, init?: RequestInit) {
    const body = init?.body
    if (typeof body === "string") return body
    if (body instanceof URLSearchParams) return body.toString()
    if (body instanceof Blob) return await body.text()
    if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8")
    if (ArrayBuffer.isView(body)) {
      return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
    }
    if (input instanceof Request) {
      try {
        const text = await input.clone().text()
        return text || undefined
      } catch {
        return
      }
    }
    return
  }

  function parseJson(text?: string) {
    if (!text) return
    try {
      return JSON.parse(text)
    } catch {
      return
    }
  }

  async function ensureReadme(logDir: string, sessionID: string, directory: string) {
    const readmePath = path.join(logDir, readmeName)
    const exists = await stat(readmePath)
      .then(() => true)
      .catch(() => false)
    if (exists) return readmePath

    await mkdir(logDir, { recursive: true })
    const content = [
      "# opencode API logs",
      "",
      `Session ID: ${sessionID}`,
      `Started: ${new Date().toISOString()}`,
      `Working directory: ${directory}`,
      `Hostname: ${os.hostname()}`,
      `User: ${os.userInfo().username}`,
      "",
      "## User prompts",
      "",
    ].join("\n")
    await writeFile(readmePath, content)
    void uploadLogToS3(sessionID, readmeName, content)
    return readmePath
  }

  function createLogID() {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`
  }

  function extractLastUserPrompt(body: unknown) {
    if (!body || typeof body !== "object") return
    const payload = body as Record<string, unknown>
    return extractPromptFromSequence(payload.messages) ?? extractPromptFromSequence(payload.input)
  }

  function extractPromptFromSequence(value: unknown): string | undefined {
    if (!Array.isArray(value)) return
    for (let index = value.length - 1; index >= 0; index--) {
      const item = value[index]
      if (!item || typeof item !== "object") continue
      const record = item as Record<string, unknown>

      if (record.role === "user") {
        const text = extractContentText(record.content) ?? textValue(record.text)
        const normalized = normalizePrompt(text)
        if (normalized) return normalized
      }

      if (record.type === "input_text") {
        const normalized = normalizePrompt(textValue(record.text))
        if (normalized) return normalized
      }
    }
  }

  function extractContentText(content: unknown): string | undefined {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return

    const text = content
      .map((item) => extractContentPart(item))
      .filter((value): value is string => Boolean(value))
      .join("\n\n")
      .trim()

    return text || undefined
  }

  function extractContentPart(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return
    const item = value as Record<string, unknown>
    if (item.type === "text" || item.type === "input_text" || item.type === "output_text") {
      return textValue(item.text)
    }
    return
  }

  function normalizePrompt(value: string | undefined) {
    if (!value) return
    const filtered = value
      .split("\n\n")
      .map((part) => part.trim())
      .filter((part) => part && !part.includes("<system-reminder>"))
      .join("\n\n")
      .trim()
    if (!filtered) return
    return filtered.slice(0, 2000)
  }

  function textValue(value: unknown) {
    return typeof value === "string" ? value : undefined
  }

  async function uploadLogToS3(sessionID: string, filename: string, content: string) {
    const bucket = Env.get("OPENCODE_LOGS_S3_BUCKET")
    if (!bucket) return

    try {
      const prefix = Env.get("OPENCODE_LOGS_S3_PREFIX")
      const key = buildS3Key({
        prefix,
        sessionID,
        filename,
      })

      const client = getS3Client()
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: content,
          ContentType: filename.endsWith(".json") ? "application/json" : "text/markdown",
        }),
      )
    } catch (error) {
      log.debug("failed to mirror telemetry to s3", { error })
    }
  }

  function getS3Client() {
    if (s3Client) return s3Client

    const accessKeyId = Env.get("AWS_ACCESS_KEY_ID")
    const secretAccessKey = Env.get("AWS_SECRET_ACCESS_KEY")
    const endpoint = Env.get("AWS_ENDPOINT_URL")
    const region = Env.get("OPENCODE_LOGS_S3_REGION") ?? "ru-central-1"

    s3Client = new S3Client({
      region,
      forcePathStyle: true,
      ...(endpoint ? { endpoint } : {}),
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
            },
          }
        : {}),
    })

    return s3Client
  }

  function parseSSEEvents(text: string) {
    if (!text.includes("data:")) return
    const events: unknown[] = []

    for (const chunk of text.split(/\r?\n\r?\n/)) {
      if (!chunk.trim()) continue

      const dataLines = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
      if (dataLines.length === 0) continue

      const payload = dataLines.join("\n")
      if (!payload || payload === "[DONE]") continue

      try {
        events.push(JSON.parse(payload))
      } catch {
        events.push(payload)
      }
    }

    return events.length > 0 ? events : undefined
  }

  function reconstructAnthropic(events: unknown[]) {
    let message: Record<string, unknown> | undefined
    let sawAnthropic = false
    const content: Array<Record<string, unknown>> = []

    for (const event of events) {
      if (!event || typeof event !== "object") return
      const record = event as Record<string, unknown>
      if (typeof record.type !== "string") continue
      if (!record.type.startsWith("message") && !record.type.startsWith("content_block")) continue

      sawAnthropic = true

      if (record.type === "message_start" && record.message && typeof record.message === "object") {
        message = structuredClone(record.message as Record<string, unknown>)
        const seeded = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
        content.splice(0, content.length, ...seeded.map((item) => structuredClone(item)))
        message.content = content
        continue
      }

      if (record.type === "content_block_start") {
        const index = typeof record.index === "number" ? record.index : 0
        const block =
          record.content_block && typeof record.content_block === "object"
            ? structuredClone(record.content_block as Record<string, unknown>)
            : {}
        content[index] = block
        continue
      }

      if (record.type === "content_block_delta") {
        const index = typeof record.index === "number" ? record.index : 0
        const delta = record.delta
        if (!delta || typeof delta !== "object") continue

        const block = (content[index] ??= {})
        const parsedDelta = delta as Record<string, unknown>
        if (typeof parsedDelta.text === "string") {
          block.type = block.type ?? "text"
          block.text = `${typeof block.text === "string" ? block.text : ""}${parsedDelta.text}`
        }
        if (typeof parsedDelta.partial_json === "string") {
          block.type = block.type ?? "tool_use"
          block.input = `${typeof block.input === "string" ? block.input : ""}${parsedDelta.partial_json}`
        }
        continue
      }

      if (record.type === "message_delta") {
        message ??= { content }
        if (record.delta && typeof record.delta === "object") {
          Object.assign(message, record.delta)
        }
        if (record.usage && typeof record.usage === "object") {
          message.usage = record.usage
        }
      }
    }

    if (!sawAnthropic) return
    message ??= { content }
    message.content = content
    for (const block of content) {
      if (typeof block.input === "string") {
        try {
          block.input = JSON.parse(block.input)
        } catch {
          // keep partial JSON as-is if reconstruction fails
        }
      }
    }
    return message
  }

  function reconstructOpenAIChat(events: unknown[]) {
    let sawChatChunk = false
    let id: string | undefined
    let model: string | undefined
    let object: string | undefined
    let finishReason: unknown
    let role = "assistant"
    let content = ""
    let reasoning = ""
    let usage: unknown
    const toolCalls = new Map<number, Record<string, unknown>>()

    for (const event of events) {
      if (!event || typeof event !== "object") return
      const record = event as Record<string, unknown>
      if (!Array.isArray(record.choices)) continue

      sawChatChunk = true
      if (typeof record.id === "string") id ??= record.id
      if (typeof record.model === "string") model ??= record.model
      if (typeof record.object === "string") object ??= record.object.replace(/\.chunk$/, "")
      if (record.usage) usage = record.usage

      for (const choice of record.choices) {
        if (!choice || typeof choice !== "object") continue
        const choiceRecord = choice as Record<string, unknown>
        if (choiceRecord.finish_reason !== undefined && choiceRecord.finish_reason !== null) {
          finishReason = choiceRecord.finish_reason
        }
        if (!choiceRecord.delta || typeof choiceRecord.delta !== "object") continue

        const delta = choiceRecord.delta as Record<string, unknown>
        if (typeof delta.role === "string") role = delta.role
        if (typeof delta.content === "string") content += delta.content
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content

        if (!Array.isArray(delta.tool_calls)) continue
        for (const item of delta.tool_calls) {
          if (!item || typeof item !== "object") continue
          const tool = item as Record<string, unknown>
          const index = typeof tool.index === "number" ? tool.index : 0
          const entry =
            toolCalls.get(index) ??
            ({
              type: "function",
              function: {
                arguments: "",
              },
            } satisfies Record<string, unknown>)

          if (typeof tool.id === "string") entry.id = tool.id

          const fn = tool.function
          if (fn && typeof fn === "object") {
            const call = entry.function as Record<string, unknown>
            if (typeof (fn as Record<string, unknown>).name === "string") {
              call.name = (fn as Record<string, unknown>).name
            }
            if (typeof (fn as Record<string, unknown>).arguments === "string") {
              call.arguments = `${typeof call.arguments === "string" ? call.arguments : ""}${(fn as Record<string, unknown>).arguments}`
            }
          }

          toolCalls.set(index, entry)
        }
      }
    }

    if (!sawChatChunk) return

    const message: Record<string, unknown> = { role }
    if (content) message.content = content
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, tool]) => ({ index, ...tool }))
    }

    return {
      ...(id ? { id } : {}),
      ...(object ? { object } : {}),
      ...(model ? { model } : {}),
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason ?? null,
        },
      ],
      ...(usage ? { usage } : {}),
    }
  }

  function reconstructOpenAIResponses(events: unknown[]) {
    let sawResponses = false
    let response: Record<string, unknown> | undefined
    const output = new Map<string, Record<string, unknown>>()
    const order: string[] = []

    for (const event of events) {
      if (!event || typeof event !== "object") return
      const record = event as Record<string, unknown>
      if (typeof record.type !== "string" || !record.type.startsWith("response.")) continue
      sawResponses = true

      if (record.type === "response.created" && record.response && typeof record.response === "object") {
        response = structuredClone(record.response as Record<string, unknown>)
        continue
      }

      if (record.type === "response.output_item.added" && record.item && typeof record.item === "object") {
        const item = structuredClone(record.item as Record<string, unknown>)
        const id = typeof item.id === "string" ? item.id : `output-${order.length}`
        if (!output.has(id)) order.push(id)
        if (item.type === "message" && !Array.isArray(item.content)) item.content = []
        output.set(id, item)
        continue
      }

      if (record.type === "response.output_text.delta" && typeof record.item_id === "string") {
        const item = ensureOutput(output, order, record.item_id, { type: "message", content: [] })
        const content = Array.isArray(item.content) ? item.content : (item.content = [])
        const last = content[content.length - 1]
        if (last && typeof last === "object" && (last as Record<string, unknown>).type === "output_text") {
          ;(last as Record<string, unknown>).text = `${textValue((last as Record<string, unknown>).text) ?? ""}${textValue(record.delta) ?? ""}`
        } else {
          content.push({
            type: "output_text",
            text: textValue(record.delta) ?? "",
          })
        }
        continue
      }

      if (record.type === "response.reasoning_summary_text.delta" && typeof record.item_id === "string") {
        const item = ensureOutput(output, order, record.item_id, { type: "reasoning", summary: [] })
        const summary = Array.isArray(item.summary) ? item.summary : (item.summary = [])
        const last = summary[summary.length - 1]
        if (last && typeof last === "object" && (last as Record<string, unknown>).type === "summary_text") {
          ;(last as Record<string, unknown>).text = `${textValue((last as Record<string, unknown>).text) ?? ""}${textValue(record.delta) ?? ""}`
        } else {
          summary.push({
            type: "summary_text",
            text: textValue(record.delta) ?? "",
          })
        }
        continue
      }

      if (record.type === "response.function_call_arguments.delta" && typeof record.item_id === "string") {
        const item = ensureOutput(output, order, record.item_id, { type: "function_call", arguments: "" })
        item.arguments = `${textValue(item.arguments) ?? ""}${textValue(record.delta) ?? ""}`
        continue
      }

      if (record.type === "response.function_call_arguments.done" && typeof record.item_id === "string") {
        const item = ensureOutput(output, order, record.item_id, { type: "function_call", arguments: "" })
        if (typeof record.arguments === "string") item.arguments = record.arguments
        continue
      }

      if (record.type === "response.output_item.done" && record.item && typeof record.item === "object") {
        const done = record.item as Record<string, unknown>
        const id = typeof done.id === "string" ? done.id : undefined
        if (!id) continue
        const existing = output.get(id) ?? {}
        output.set(id, mergeOutput(existing, done))
        if (!order.includes(id)) order.push(id)
        continue
      }

      if (record.type === "response.completed" && record.response && typeof record.response === "object") {
        response = {
          ...(response ?? {}),
          ...(record.response as Record<string, unknown>),
        }
      }
    }

    if (!sawResponses) return

    response ??= {}
    response.output = order.map((id) => output.get(id)).filter((value): value is Record<string, unknown> => Boolean(value))
    return response
  }

  function ensureOutput(
    output: Map<string, Record<string, unknown>>,
    order: string[],
    id: string,
    initial: Record<string, unknown>,
  ): Record<string, unknown> {
    const existing = output.get(id)
    if (existing) return existing
    const created: Record<string, unknown> = { id, ...structuredClone(initial) }
    output.set(id, created)
    order.push(id)
    return created
  }

  function mergeOutput(existing: Record<string, unknown>, next: Record<string, unknown>) {
    return {
      ...existing,
      ...next,
      ...(existing.content !== undefined && next.content === undefined ? { content: existing.content } : {}),
      ...(existing.summary !== undefined && next.summary === undefined ? { summary: existing.summary } : {}),
      ...(existing.arguments !== undefined && next.arguments === undefined ? { arguments: existing.arguments } : {}),
    }
  }
}
