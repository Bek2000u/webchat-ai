import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateText, Output, jsonSchema, type ModelMessage } from "ai";
import { z } from "zod";
import {
  MODELS,
  modelSpec,
  jsonObjectSchema,
  type TextDTO,
  type ThinkingMode,
} from "../shared/contracts.js";
import { BrowserDispatcher } from "./runtime.js";
import { ServiceError } from "./errors.js";

export function thinkingMode(effort: unknown): ThinkingMode {
  if (effort === undefined || effort === null || effort === "provider-default")
    return "default";
  if (["none", "minimal", "low"].includes(String(effort))) return "fast";
  if (["medium", "high", "xhigh", "max"].includes(String(effort)))
    return "deep";
  throw new ServiceError(
    "Unsupported reasoning effort",
    400,
    "unsupported_parameter",
    "reasoning_effort",
  );
}

export class BrowserLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "webchat-ai";
  readonly supportedUrls = {};
  constructor(
    readonly modelId: string,
    private host: BrowserDispatcher,
    private state: Record<string, unknown> = {},
  ) {
    if (modelSpec(modelId)?.kind !== "text")
      throw new ServiceError(
        "Text model not found",
        404,
        "model_not_found",
        "model",
      );
  }
  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    if (options.tools?.length)
      throw new ServiceError(
        "Browser text providers do not support tool calls",
        400,
        "unsupported_parameter",
        "tools",
      );
    for (const key of [
      "temperature",
      "topP",
      "topK",
      "maxOutputTokens",
      "presencePenalty",
      "frequencyPenalty",
      "seed",
    ] as const)
      if (options[key] !== undefined)
        throw new ServiceError(
          `Browser UI cannot apply ${key}`,
          400,
          "unsupported_parameter",
          key,
        );
    if (options.stopSequences?.length)
      throw new ServiceError(
        "Browser UI cannot apply stop sequences",
        400,
        "unsupported_parameter",
        "stop",
      );
    const providerOptions = options.providerOptions?.webchatAI ?? {};
    const effort =
      options.reasoning && options.reasoning !== "provider-default"
        ? options.reasoning
        : providerOptions.reasoningEffort;
    const dto: TextDTO = {
      model: this.modelId,
      messages: [],
      modelOptions: { thinking: thinkingMode(effort) },
    };
    for (const message of options.prompt) {
      if (message.role === "system") {
        dto.messages.push({ role: "system", content: message.content });
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant")
        throw new ServiceError(
          "Browser text providers accept text messages only",
          400,
          "unsupported_parameter",
          "messages",
        );
      const content = message.content
        .map((part) => {
          if (part.type !== "text")
            throw new ServiceError(
              "Browser text attachments are not implemented",
              400,
              "unsupported_parameter",
              "messages",
            );
          return part.text;
        })
        .join("");
      dto.messages.push({ role: message.role, content });
    }
    if (!dto.messages.length)
      throw new ServiceError("Text input is required", 400);
    if (options.responseFormat?.type === "json")
      dto.outputSchema = jsonObjectSchema.parse(
        options.responseFormat.schema ?? { type: "object" },
      );
    const record = await this.host.execute(
      { kind: "text", options: dto },
      options.abortSignal,
    );
    const result = record.result;
    const value =
      result && typeof result === "object" && "text" in result
        ? result
        : undefined;
    const text =
      value && typeof value.text === "string" ? value.text : undefined;
    if (!text?.trim())
      throw new ServiceError(
        "Browser provider returned no completed text",
        502,
        "invalid_provider_response",
      );
    if (dto.outputSchema) {
      try {
        JSON.parse(text);
      } catch {
        throw new ServiceError(
          "Browser provider returned invalid structured JSON",
          502,
          "INVALID_STRUCTURED_OUTPUT",
        );
      }
    }
    const usage =
      value &&
      "usage" in value &&
      value.usage &&
      typeof value.usage === "object"
        ? (value.usage as Record<string, number>)
        : undefined;
    this.state.usageAvailable = usage !== undefined;
    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      warnings: [],
      usage: {
        inputTokens: {
          total: usage?.promptTokens,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: usage?.completionTokens,
          text: undefined,
          reasoning: undefined,
        },
      },
      response: {
        id: record.id,
        timestamp: new Date(record.updatedAt),
        modelId: record.attempts.at(-1)?.model ?? this.modelId,
      },
      providerMetadata: {
        webchatAI: { requestId: record.id, delivery: "buffered", resolvedModel: record.attempts.at(-1)?.model ?? this.modelId },
      },
    };
  }
  async doStream(options: LanguageModelV4CallOptions) {
    // The site currently returns completed DOM text, not live token deltas.
    const result = await this.doGenerate(options);
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          const id = result.response!.id!;
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "response-metadata", ...result.response });
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({
            type: "text-delta",
            id,
            delta: result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          });
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
            providerMetadata: result.providerMetadata,
          });
          controller.close();
        },
      }),
    };
  }
}

const part = z.object({
  type: z.enum(["text", "input_text", "output_text"]),
  text: z.string(),
});
const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(part)]),
  type: z.literal("message").optional(),
});
const common = {
  model: z.string().min(1),
  stream: z.boolean().optional(),
  reasoning_effort: z.string().nullish(),
  reasoning: z.object({ effort: z.string().optional() }).nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
};
const chatBody = z.looseObject({
  ...common,
  messages: z.array(message).min(1),
});
const responsesBody = z.looseObject({
  ...common,
  input: z.union([z.string().min(1), z.array(message).min(1)]),
  instructions: z.string().nullish(),
});
const format = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z
      .object({
        name: z.string(),
        schema: jsonObjectSchema,
        strict: z.boolean().optional(),
      })
      .optional(),
    name: z.string().optional(),
    schema: jsonObjectSchema.optional(),
    strict: z.boolean().optional(),
  }),
]);

function rejectUnsupported(body: Record<string, unknown>) {
  for (const key of [
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "stop",
    "logprobs",
    "top_logprobs",
    "audio",
    "modalities",
    "prediction",
  ])
    if (body[key] !== undefined && body[key] !== null)
      throw new ServiceError(
        `Browser UI cannot apply ${key}`,
        400,
        "unsupported_parameter",
        key,
      );
  if (
    (Array.isArray(body.tools) && body.tools.length) ||
    (Array.isArray(body.functions) && body.functions.length) ||
    (body.tool_choice && !["auto", "none"].includes(String(body.tool_choice)))
  )
    throw new ServiceError(
      "Browser text providers do not support tool calls",
      400,
      "unsupported_parameter",
      "tools",
    );
  for (const key of [
    "conversation",
    "previous_response_id",
    "background",
    "store",
  ])
    if (body[key])
      throw new ServiceError(
        "Browser text requests are stateless",
        400,
        "unsupported_parameter",
        key,
      );
  if (body.n !== undefined && body.n !== 1)
    throw new ServiceError(
      "Browser text supports one response per request",
      400,
      "unsupported_parameter",
      "n",
    );
}
function promptMessages(messages: z.infer<typeof message>[]): ModelMessage[] {
  return messages.map((item) => ({
    role: item.role === "developer" ? "system" : item.role,
    content:
      typeof item.content === "string"
        ? item.content
        : item.content.map((value) => value.text).join(""),
  }));
}
function sse(frames: Array<{ event?: string; data: unknown }>, done = false) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames)
          controller.enqueue(
            encoder.encode(
              `${frame.event ? "event: " + frame.event + "\n" : ""}data: ${JSON.stringify(frame.data)}\n\n`,
            ),
          );
        if (done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    },
  );
}

export function createTextEndpoints(host: BrowserDispatcher) {
  async function handle(request: Request, responses: boolean) {
    const raw = await request.json();
    const body = responses ? responsesBody.parse(raw) : chatBody.parse(raw);
    rejectUnsupported(body);
    const messages = responses
      ? typeof body.input === "string"
        ? [{ role: "user" as const, content: body.input }]
        : body.input
      : body.messages;
    const normalized = promptMessages(messages as z.infer<typeof message>[]);
    if (responses && typeof body.instructions === "string")
      normalized.unshift({ role: "system", content: body.instructions });
    const rawFormat = responses
      ? (body.text as { format?: unknown } | undefined)?.format
      : body.response_format;
    const selected =
      rawFormat === undefined ? undefined : format.parse(rawFormat);
    const output =
      selected?.type === "json_schema"
        ? Output.object({
            schema: jsonSchema(
              selected.json_schema?.schema ?? selected.schema ?? {},
            ),
          })
        : selected?.type === "json_object"
          ? Output.json()
          : undefined;
    const state: Record<string, unknown> = {};
    const model = new BrowserLanguageModel(body.model, host, state);
    const result = await generateText({
      model,
      messages: normalized,
      allowSystemInMessages: true,
      maxRetries: 0,
      abortSignal: request.signal,
      reasoning: undefined,
      providerOptions: {
        webchatAI: {
          reasoningEffort:
            body.reasoning?.effort ?? body.reasoning_effort ?? null,
        },
      },
      ...(output ? { output } : {}),
    });
    const step = result.finalStep;
    const id = step.response.id!,
      created = Math.floor(
        (step.response.timestamp ?? new Date()).getTime() / 1000,
      );
    const usage = state.usageAvailable
      ? {
          input: result.usage.inputTokens ?? 0,
          output: result.usage.outputTokens ?? 0,
          total: result.usage.totalTokens ?? 0,
        }
      : null;
    const headers = { "x-request-id": id, "x-should-retry": "false" };
    if (!responses) {
      const chatUsage = usage
        ? {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.total,
          }
        : null;
      if (!body.stream)
        return Response.json(
          {
            id,
            object: "chat.completion",
            created,
            model: step.response.modelId ?? body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.text,
                  refusal: null,
                },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: chatUsage,
          },
          { headers },
        );
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: step.response.modelId ?? body.model,
      };
      const frames = [
        {
          data: {
            ...chunk,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: result.text },
                finish_reason: null,
              },
            ],
          },
        },
        {
          data: {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        },
      ];
      if (
        (body.stream_options as { include_usage?: boolean } | undefined)
          ?.include_usage
      )
        frames.push({
          data: { ...chunk, choices: [], usage: chatUsage },
        } as (typeof frames)[number]);
      const response = sse(frames, true);
      Object.entries(headers).forEach(([key, value]) =>
        response.headers.set(key, value),
      );
      return response;
    }
    const itemId = "msg_" + id.replaceAll("-", "");
    const textPart = {
      type: "output_text" as const,
      text: result.text,
      annotations: [],
      logprobs: [],
    };
    const item = {
      id: itemId,
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [textPart],
    };
    const complete = {
      id,
      object: "response" as const,
      created_at: created,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: step.response.modelId ?? body.model,
      output: [item],
      instructions: body.instructions ?? null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      usage: usage
        ? {
            input_tokens: usage.input,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.output,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.total,
          }
        : null,
      metadata: body.metadata ?? {},
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      truncation: "disabled",
    };
    if (!body.stream) return Response.json(complete, { headers });
    let sequence = 0;
    const event = (type: string, fields: Record<string, unknown>) => ({
      event: type,
      data: { type, sequence_number: sequence++, ...fields },
    });
    const pending = {
      ...complete,
      status: "in_progress",
      output: [],
      usage: null,
    };
    const position = { item_id: itemId, output_index: 0, content_index: 0 };
    const response = sse([
      event("response.created", { response: pending }),
      event("response.in_progress", { response: pending }),
      event("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      }),
      event("response.content_part.added", {
        ...position,
        part: { ...textPart, text: "" },
      }),
      event("response.output_text.delta", {
        ...position,
        delta: result.text,
        logprobs: [],
      }),
      event("response.output_text.done", {
        ...position,
        text: result.text,
        logprobs: [],
      }),
      event("response.content_part.done", { ...position, part: textPart }),
      event("response.output_item.done", { output_index: 0, item }),
      event("response.completed", { response: complete }),
    ]);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
  return {
    chat: { handler: (request: Request) => handle(request, false) },
    responses: { handler: (request: Request) => handle(request, true) },
  };
}
