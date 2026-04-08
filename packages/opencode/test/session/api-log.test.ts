import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-telemetry",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-telemetry",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-telemetry",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(createChatStream("Hello telemetry"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
})

beforeEach(() => {})

afterAll(() => {
  state.server?.stop()
})

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await Bun.sleep(25)
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}

describe("session api logs", () => {
  test("writes README, request, and response logs for streaming LLM calls", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["telemetry-provider"],
            provider: {
              "telemetry-provider": {
                name: "Telemetry Provider",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url.origin}/v1`,
                models: {
                  "test-model": {
                    name: "Test Model",
                    tool_call: true,
                    limit: {
                      context: 128000,
                      output: 4096,
                    },
                  },
                },
                options: {
                  apiKey: "test-key",
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel(ProviderID.make("telemetry-provider"), ModelID.make("test-model"))
        const sessionID = SessionID.make("session-telemetry-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-telemetry-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("telemetry-provider"), modelID: model.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Log this prompt please" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const logDir = path.join(tmp.path, ".opencode-logs", sessionID)
        const readme = await waitFor(async () => {
          const file = path.join(logDir, "README.md")
          return (await Bun.file(file).exists()) ? Filesystem.readText(file) : undefined
        })

        expect(readme).toContain("Session ID: session-telemetry-1")
        expect(readme).toContain(`Working directory: ${tmp.path}`)
        expect(readme).toContain("Log this prompt please")

        const requestFiles = await waitFor(async () => {
          const entries = await Array.fromAsync(new Bun.Glob("*_request.json").scan({ cwd: logDir }))
          return entries.length > 0 ? entries : undefined
        })
        const responseFiles = await waitFor(async () => {
          const entries = await Array.fromAsync(new Bun.Glob("*_response.json").scan({ cwd: logDir }))
          return entries.length > 0 ? entries : undefined
        })

        expect(requestFiles).toHaveLength(1)
        expect(responseFiles).toHaveLength(1)

        const requestPayload = JSON.parse(await Filesystem.readText(path.join(logDir, requestFiles[0])))
        expect(requestPayload.source).toBe("telemetry-provider/test-model")
        expect(requestPayload.method).toBe("POST")
        expect(requestPayload.url).toContain("/chat/completions")
        expect(Array.isArray(requestPayload.body.messages)).toBe(true)

        const responsePayload = JSON.parse(await Filesystem.readText(path.join(logDir, responseFiles[0])))
        expect(responsePayload.status).toBe(200)
        expect(responsePayload.headers["content-type"]).toContain("text/event-stream")
        expect(responsePayload.body.choices[0].message.content).toBe("Hello telemetry")
      },
    })
  })
})
