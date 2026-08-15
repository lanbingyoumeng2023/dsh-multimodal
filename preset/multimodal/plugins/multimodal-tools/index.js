// Multimodal tools plugin (persistent agent-preset version)
// 多模态工具插件（固化版）
//
// Registers three model tools:
//   multimodal_analyze_image    image understanding (vision) — URL or local path
//   multimodal_generate_image   text-to-image / image editing
//   multimodal_generate_video   text-to-video / image-to-video (async task + polling)
// 注册三个模型工具：
//   multimodal_analyze_image    图像理解（识图）—— URL 或本地路径
//   multimodal_generate_image   文生图 / 图编辑
//   multimodal_generate_video   文生视频 / 图生视频（异步任务 + 轮询）
//
// The API key is not in code or config: at runtime it is resolved via the
//   ~/.dsh/secrets/Get-MultimodalKey.ps1 DPAPI helper and cached in-process.
// API Key 不在代码与配置里：运行时经 PowerShell 调用
//   ~/.dsh/secrets/Get-MultimodalKey.ps1 解密 DPAPI 存储后取用，并缓存在进程内。

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "multimodal-tools";
/** 硬依赖：tools 注册表。 */
export const inject = ["tools"];

// 配置：环境变量优先（开源友好），缺省走内置占位默认值
const DEFAULT_BASE = process.env.MULTIMODAL_BASE_URL || "https://your-multimodal-provider.example.com/v1";
const VIDEO_POLL_HOST = process.env.MULTIMODAL_VIDEO_HOST || "https://your-multimodal-provider.example.com";
const VIDEO_POLL_PATH = process.env.MULTIMODAL_VIDEO_POLL_PATH || "/videos/tasks?video_id=";
const MODEL_TEXT_VISION = process.env.MULTIMODAL_VISION_MODEL || "your-vision-model";
const MODEL_IMAGE = process.env.MULTIMODAL_IMAGE_MODEL || "your-image-model";
const MODEL_VIDEO = process.env.MULTIMODAL_VIDEO_MODEL || "your-video-model";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

let cachedKey = null;

// ── API Key（DPAPI，经 Get-MultimodalKey.ps1 取用）──────────────────────────────

function keyScriptPath() {
  return path.join(os.homedir(), ".dsh", "secrets", "Get-MultimodalKey.ps1");
}

function runPwsh(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error("multimodal: powershell 取 key 失败: " + (stderr || err.message)));
        else resolve(stdout.trim());
      },
    );
  });
}

async function getKey() {
  if (cachedKey) return cachedKey;
  // 1) 环境变量优先（开源友好）
  let key = process.env.MULTIMODAL_API_KEY;
  if (key && key.startsWith("sk-")) { cachedKey = key; return key; }
  // 2) DPAPI 兜底（本机历史配置）
  key = await runPwsh("& '" + keyScriptPath().replace(/'/g, "''") + "'");
  if (!key || !key.startsWith("sk-")) {
    throw new Error("multimodal: 未配置 API Key —— 请设置环境变量 MULTIMODAL_API_KEY，或确保 DPAPI 存储可取用");
  }
  cachedKey = key;
  return key;
}

// ── HTTP 基础 ──────────────────────────────────────────────────────────────

function mergeSignal(exec, timeoutMs) {
  const parts = [];
  if (exec && exec.signal) parts.push(exec.signal);
  parts.push(AbortSignal.timeout(timeoutMs));
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}

async function multimodalPost(base, pathname, body, exec, timeoutMs) {
  const key = await getKey();
  const res = await fetch(base + pathname, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: mergeSignal(exec, timeoutMs || 120000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = json && json.error ? (json.error.message || JSON.stringify(json.error)) : text.slice(0, 300);
    throw new Error("multimodal api " + res.status + ": " + detail);
  }
  return json;
}

async function multimodalGetJson(url, exec, timeoutMs) {
  const key = await getKey();
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: "Bearer " + key },
    signal: mergeSignal(exec, timeoutMs || 20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = json && json.error ? (json.error.message || JSON.stringify(json.error)) : text.slice(0, 300);
    throw new Error("multimodal api " + res.status + ": " + detail);
  }
  return json;
}

// ── 图片工具函数 ───────────────────────────────────────────────────────────

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** 本地路径转 data URL；URL 原样返回。 */
async function toDataUrl(input) {
  if (isHttpUrl(input)) return input;
  const buf = await fsp.readFile(input);
  const ext = path.extname(String(input)).toLowerCase();
  return "data:" + (MIME[ext] || "application/octet-stream") + ";base64," + buf.toString("base64");
}

async function downloadToFile(url, outputDir, prefix) {
  await fsp.mkdir(outputDir, { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
  let ext = ".png";
  for (const [k, v] of Object.entries(MIME)) {
    if (v === ct) { ext = k; break; }
  }
  const file = path.join(outputDir, prefix + "-" + Date.now() + ext);
  await fsp.writeFile(file, buf);
  return file;
}

function textRender(_args, value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

// ── 工具定义（构造与 defineTool 相同的 ToolDefinition 形状）────────────────

function makeTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: spec.outputSchema, render: textRender },
    timeoutMs: spec.timeoutMs,
    async execute(args, exec) {
      return spec.execute(args, exec);
    },
  };
}

// ── 识图 ───────────────────────────────────────────────────────────────────

async function executeAnalyzeImage(args, exec) {
  const question = args.question && args.question.trim() ? args.question : "描述这张图片。";
  const detail = args.detail === "low" ? "low" : "high";
  const imageUrl = await toDataUrl(args.image);
  const json = await multimodalPost(DEFAULT_BASE, "/chat/completions", {
    model: MODEL_TEXT_VISION,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: question },
        { type: "image_url", image_url: { url: imageUrl, detail } },
      ],
    }],
  }, exec, 120000);
  const answer = json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : "(空响应)";
  return { answer, model: MODEL_TEXT_VISION };
}

// ── 生图 / 图编辑 ──────────────────────────────────────────────────────────

async function executeGenerateImage(args, exec, config) {
  const body = {
    model: MODEL_IMAGE,
    prompt: args.prompt,
  };
  if (args.size) body.size = args.size;
  if (args.image) {
    if (!isHttpUrl(args.image)) {
      throw new Error("multimodal_generate_image 的参考图必须是 http(s) URL（本地路径仅 multimodal_analyze_image 支持）");
    }
    body.extra_body = { image: [args.image], response_format: "url" };
  } else {
    body.extra_body = { response_format: "url" };
  }
  const json = await multimodalPost(DEFAULT_BASE, "/images/generations", body, exec, 180000);
  const items = (json && Array.isArray(json.data)) ? json.data : [];
  const urls = items.map((it) => it.url || it.b64_json || null).filter(Boolean);
  let localPath = null;
  if (urls.length > 0 && isHttpUrl(urls[0])) {
    try {
      localPath = await downloadToFile(urls[0], config.outputDir, "multimodal-img");
    } catch (e) {
      localPath = null;
    }
  }
  return { urls, localPath, model: MODEL_IMAGE };
}

// ── 生视频（异步任务 + 轮询）───────────────────────────────────────────────

function videoPollUrl(videoId) {
  return VIDEO_POLL_HOST + VIDEO_POLL_PATH + encodeURIComponent(videoId);
}

async function executeGenerateVideo(args, exec, config) {
  const body = {
    model: MODEL_VIDEO,
    prompt: args.prompt,
  };
  if (args.image) {
    if (!isHttpUrl(args.image)) {
      throw new Error("multimodal_generate_video 的输入图必须是 http(s) URL（本地路径仅 multimodal_analyze_image 支持）");
    }
    body.image = args.image;
  }
  if (args.width) body.width = args.width;
  if (args.height) body.height = args.height;
  if (args.num_frames) body.num_frames = args.num_frames;
  if (args.frame_rate) body.frame_rate = args.frame_rate;
  if (args.seed !== undefined && args.seed !== null) body.seed = args.seed;
  if (args.negative_prompt) body.negative_prompt = args.negative_prompt;

  const created = await multimodalPost(DEFAULT_BASE, "/videos", body, exec, 60000);
  const videoId = created.video_id || created.task_id;
  if (!videoId) {
    throw new Error("multimodal_generate_video: 创建任务未返回 video_id/task_id: " + JSON.stringify(created));
  }

  if (args.wait === false) {
    return { videoId, status: created.status || "queued", pollUrl: videoPollUrl(videoId) };
  }

  const deadline = Date.now() + config.pollTimeoutMs;
  const interval = config.pollIntervalMs;
  for (;;) {
    const snap = await multimodalGetJson(videoPollUrl(videoId), exec, 30000);
    const status = String(snap.status || snap.state || "unknown");
    if (status === "completed") {
      const videoUrl = snap.video_url || snap.url || snap.video || null;
      return {
        videoId,
        status: "completed",
        videoUrl,
        size: snap.size || null,
        seconds: snap.seconds || (snap.usage && snap.usage.duration_seconds) || null,
      };
    }
    if (status === "failed" || status === "error") {
      throw new Error("multimodal_generate_video: 任务失败: " + JSON.stringify(snap).slice(0, 500));
    }
    if (Date.now() > deadline) {
      return {
        videoId,
        status: "in_progress",
        pollUrl: videoPollUrl(videoId),
        note: "超时未完成，可用返回的 pollUrl 继续查询",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const outputDir = config.outputDir || path.join(os.homedir(), "Pictures", "dsh-multimodal");
  const resolved = {
    outputDir,
    pollIntervalMs: config.pollIntervalMs || 5000,
    pollTimeoutMs: config.pollTimeoutMs || 300000,
  };

  ctx.tools.register(makeTool({
    name: "multimodal_analyze_image",
    description: "用 多模态 多模态模型分析一张图片（识图）：支持 http(s) URL 或本地文件路径，可针对图片提问（描述内容、识别文字、理解图表等）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        image: { type: "string", description: "图片：http(s) URL 或本地文件路径。" },
        question: { type: "string", description: "针对图片的问题；缺省为“描述这张图片”。" },
        detail: { type: "string", description: "视觉细节级别：low 或 high，默认 high。" },
      },
      required: ["image"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
        model: { type: "string" },
      },
      required: ["answer"],
    },
    timeoutMs: 150000,
    execute: executeAnalyzeImage,
  }));

  ctx.tools.register(makeTool({
    name: "multimodal_generate_image",
    description: "用 多模态 文生图/图编辑模型生成或编辑图片。参考图（编辑）需为 http(s) URL。生成后自动下载到本地并返回本地路径。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "英文描述：主体 + 场景 + 风格 + 光照 + 构图 + 质量要求。" },
        size: { type: "string", description: "输出尺寸，如 1024x768。" },
        image: { type: "string", description: "可选：参考图 http(s) URL（图生图/编辑时传）。" },
      },
      required: ["prompt"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        urls: { type: "array", items: { type: "string" } },
        localPath: { type: "string" },
        model: { type: "string" },
      },
      required: ["urls"],
    },
    timeoutMs: 200000,
    execute: (args, exec) => executeGenerateImage(args, exec, resolved),
  }));

  ctx.tools.register(makeTool({
    name: "multimodal_generate_video",
    description: "用 多模态 生成视频（文生视频或图生视频，图需 http(s) URL）。异步任务：创建后轮询直到完成，返回视频 URL 与时长。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "英文视频描述（保留主体/动作/场景/运镜/光照/风格）。" },
        image: { type: "string", description: "可选：图生视频的输入图 http(s) URL。" },
        width: { type: "number", description: "宽度，默认 1152。" },
        height: { type: "number", description: "高度，默认 768。" },
        num_frames: { type: "number", description: "帧数，<=441 且满足 8n+1，默认 121。" },
        frame_rate: { type: "number", description: "帧率 1-60，默认 24。" },
        seed: { type: "number", description: "随机种子，用于复现。" },
        negative_prompt: { type: "string", description: "负向提示词。" },
        wait: { type: "boolean", description: "是否等待任务完成（默认 true）；false 只返回 video_id 与轮询地址。" },
      },
      required: ["prompt"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        videoId: { type: "string" },
        status: { type: "string" },
        videoUrl: { type: "string" },
        pollUrl: { type: "string" },
        seconds: { type: "number" },
        note: { type: "string" },
      },
      required: ["videoId", "status"],
    },
    timeoutMs: 360000,
    execute: (args, exec) => executeGenerateVideo(args, exec, resolved),
  }));
}
