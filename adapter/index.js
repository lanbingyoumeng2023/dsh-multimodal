// dsh-llm-multimodal — 零依赖自包含的多模态 LLM 适配器（支持图片）
// 不 import 任何 @deepseek-ai/* 包，放在 profile 目录用相对路径注册，规避 npx 缓存的依赖/剪枝问题。
// OpenAI 兼容：/chat/completions + SSE 流式；图片块 → image_url。

export const name = "llm-multimodal";
export const inject = ["llm"];

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

// ── 配置（环境变量）────────────────────────────────────────────────────────
function cfg() {
  return {
    baseUrl: () => process.env.MULTIMODAL_BASE_URL || "https://your-multimodal-provider.example.com/v1",
    apiKey: () => process.env.MULTIMODAL_API_KEY,
    modelId: () => process.env.MULTIMODAL_VISION_MODEL || "your-vision-model",
    modelName: () => process.env.MULTIMODAL_VISION_MODEL || "your-vision-model",
    contextWindow: () => Number(process.env.MULTIMODAL_CONTEXT_WINDOW || 131072),
  };
}

// ── 序列化（图片 → image_url）──────────────────────────────────────────────
function flattenText(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function imageToDataUrl(block, attachments) {
  const ref = block.attachment;
  if (!ref || !attachments) return null;
  try {
    const stored = await attachments.readImage(ref);
    const mediaType = stored.ref.mediaType || ref.mediaType || "image/png";
    const b64 = Buffer.from(stored.data).toString("base64");
    return `data:${mediaType};base64,${b64}`;
  } catch {
    return null;
  }
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({
    id: b.id, type: "function", function: { name: b.name, arguments: b.arguments },
  }));
  return { role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}

async function serializeMessages(messages, attachments) {
  const wire = [];
  for (const message of messages) {
    if (message.role === "system") { wire.push({ role: "system", content: flattenText(message.content) }); continue; }
    if (message.role === "assistant") { wire.push(serializeAssistant(message)); continue; }
    const toolResults = message.content.filter((b) => b.type === "tool-result");
    const text = flattenText(message.content);
    const images = message.content.filter((b) => b.type === "image");
    if (images.length > 0) {
      const parts = [];
      if (text.length > 0) parts.push({ type: "text", text });
      for (const img of images) {
        const url = await imageToDataUrl(img, attachments);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
      wire.push({ role: "user", content: parts.length > 0 ? parts : text });
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const r of toolResults) wire.push({ role: "tool", tool_call_id: r.toolCallId, content: flattenText(r.content) || "(no output)" });
  }
  return wire;
}

async function serializeRequest(options, c, attachments) {
  const messages = await serializeMessages(options.messages, attachments);
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools !== void 0 && options.tools.length > 0 ? {
      tools: options.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    } : {}),
    ...(options.temperature !== void 0 ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }),
  };
}

// ── SSE 解析（手写，无 eventsource-parser）────────────────────────────────
async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          yield data;
          if (data === "[DONE]") return;
        }
      }
    }
  }
  throw err("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}),
  };
}

function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "tool-call": return { type: "tool-call", id: block.callId ?? "", name: block.name ?? "", arguments: block.text };
  }
}

async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  const open = (kind) => { const b = { index: nextIndex++, kind, text: "" }; order.push(b); return b; };
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0
          ? { kind: "error", failure: { message: "model returned a completed response with no content", code: "EMPTY_RESPONSE" } }
          : reason,
      };
      return;
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { throw err(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE"); }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) { textBlock = open("text"); yield { type: "block-start", index: textBlock.index, blockType: "text" }; }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) { block = open("tool-call"); toolBlocks.set(call.index, block); yield { type: "block-start", index: block.index, blockType: "tool-call" }; }
        if (call.id !== void 0) block.callId = call.id;
        if (call.function?.name !== void 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield { type: "tool-call-delta", index: block.index, id: block.callId ?? "", ...(block.name !== void 0 ? { name: block.name } : {}), argumentsDelta: fragment };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw err("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

// ── 适配器（普通对象，无 LlmAdapter 继承）────────────────────────────────
function makeAdapter(c, attachments) {
  return {
    providerInfo(provider) { return { id: provider, name: "多模态" }; },
    providerRetryPolicy() { return undefined; },
    listModels(provider) {
      const id = c.modelId();
      return Promise.resolve([{ provider, id, name: c.modelName(), inputModalities: ["text", "image"] }]);
    },
    resolveModel(provider) {
      return Promise.resolve({
        provider, id: c.modelId(), name: c.modelName(),
        inputModalities: ["text", "image"],
        context: { contextWindow: c.contextWindow() },
        defaultMaxTokens: 8192,
      });
    },
    async *stream(options) {
      const baseUrl = c.baseUrl();
      const apiKey = c.apiKey();
      if (!apiKey) throw err("多模态适配器未配置 MULTIMODAL_API_KEY", "MISSING_CREDENTIAL");
      const body = await serializeRequest(options, c, attachments());
      const controller = new AbortController();
      const signal = options.signal ?? controller.signal;
      let response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw err("多模态请求被取消", "ABORTED");
        throw err(`多模态 API 请求失败: ${baseUrl}`, "TRANSPORT");
      }
      if (!response.ok) {
        let msg = `多模态 API 错误 (HTTP ${response.status})`;
        try { const j = await response.json(); if (j.error?.message) msg = j.error.message; } catch {}
        throw err(msg, httpErrorCode(response.status));
      }
      if (!response.body) throw err("多模态 API 无响应体", "EMPTY_RESPONSE");
      yield* translate(parseSse(response.body));
    },
  };
}

// ── 注册 ───────────────────────────────────────────────────────────────────
export function apply(ctx) {
  const llm = ctx.get("llm");
  if (llm === undefined) return;
  const attachments = () => ctx.get("attachments");
  llm.registerAdapter(["multimodal"], makeAdapter(cfg(), attachments));
}
