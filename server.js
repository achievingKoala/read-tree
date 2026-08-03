const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MAX_BODY_BYTES = 250_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const QUESTIONS_PER_BATCH = 3;

loadEnv(path.join(ROOT, ".env"));

const ACTIVATION_PROJECT = process.env.ACTIVATION_PROJECT || "read-tree";
const DEFAULT_NEW_CLIENT_QUOTA = parseNonNegativeInteger(
  process.env.DEFAULT_NEW_CLIENT_QUOTA,
  20
);
const QUOTA_INSUFFICIENT_MESSAGE =
  "AI 使用次数不足，可以联系小红书作者购买更多次数";
const port = parsePort(process.env.PORT);
const host = process.env.HOST || "0.0.0.0";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parsePort(value) {
  const parsed = Number(value || 3000);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : 3000;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeClientErrorMessage(message) {
  if (typeof message !== "string") {
    return "请求格式无效";
  }

  if (message.includes("AI 使用次数不足")) {
    return QUOTA_INSUFFICIENT_MESSAGE;
  }

  return message;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new ClientError("请求内容过长"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        return;
      }
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (_error) {
        reject(new ClientError("请求格式无效"));
      }
    });
    request.on("error", reject);
  });
}

class ClientError extends Error {}

function isActivationRequired() {
  return process.env.ACTIVATION_REQUIRED === "true";
}

function getSupabaseConfig() {
  const url = optionalString(process.env.SUPABASE_URL, "Supabase URL", 300);
  const key = optionalString(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Supabase Service Role Key",
    1_000
  );

  if (!url || !key) {
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    key,
  };
}

function normalizeActivationCode(value) {
  return requiredString(value, "激活码", 80).toUpperCase();
}

function requiredClientId(value) {
  const clientId = requiredString(value, "客户端标识", 120);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      clientId
    )
  ) {
    throw new ClientError("客户端标识格式无效");
  }
  return clientId;
}

async function supabaseRequest(pathname, options = {}) {
  const config = getSupabaseConfig();
  if (!config) {
    throw new ClientError("激活码系统尚未配置，请先设置 Supabase 环境变量");
  }

  const upstream = await fetch(`${config.url}/rest/v1${pathname}`, {
    method: options.method || "GET",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let data = null;
  const text = await upstream.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = text;
    }
  }

  if (!upstream.ok) {
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof data === "string"
          ? data
          : `Supabase returned ${upstream.status}`;
    if (data?.code === "P0001") {
      throw new ClientError(normalizeClientErrorMessage(message));
    }
    const error = new Error(message);
    error.publicMessage = "激活码系统暂时不可用，请稍后重试";
    throw error;
  }

  return data;
}

function normalizeQuotaRow(row) {
  return {
    remainingUses: Number(row?.remaining_reviews || 0),
    totalGranted: Number(row?.total_granted || 0),
    totalUsed: Number(row?.total_used || 0),
  };
}

async function getClientQuota(clientId) {
  const quota = await fetchClientQuota(clientId);
  if (quota) {
    return normalizeQuotaRow(quota);
  }

  const initialQuota = await grantInitialClientQuota(clientId);
  return normalizeQuotaRow(initialQuota);
}

async function fetchClientQuota(clientId) {
  const rows = await supabaseRequest(
    `/client_quotas?client_id=eq.${encodeURIComponent(
      clientId
    )}&project_name=eq.${encodeURIComponent(
      ACTIVATION_PROJECT
    )}&select=remaining_reviews,total_granted,total_used&limit=1`,
    {
      method: "GET",
    }
  );

  return Array.isArray(rows) ? rows[0] : null;
}

async function grantInitialClientQuota(clientId) {
  if (DEFAULT_NEW_CLIENT_QUOTA <= 0) {
    return null;
  }

  await supabaseRequest(
    `/client_quotas?on_conflict=${encodeURIComponent(
      "project_name,client_id"
    )}`,
    {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: {
        client_id: clientId,
        project_name: ACTIVATION_PROJECT,
        remaining_reviews: DEFAULT_NEW_CLIENT_QUOTA,
        total_granted: DEFAULT_NEW_CLIENT_QUOTA,
        total_used: 0,
        updated_at: new Date().toISOString(),
      },
    }
  );

  return fetchClientQuota(clientId);
}

async function redeemActivationCode(clientId, code) {
  const rows = await supabaseRequest("/rpc/redeem_activation_code", {
    method: "POST",
    body: {
      p_client_id: clientId,
      p_code: code,
      p_project_name: ACTIVATION_PROJECT,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return normalizeQuotaRow(row);
}

async function spendClientQuota(clientId, reason) {
  await grantInitialClientQuota(clientId);

  const rows = await supabaseRequest("/rpc/spend_client_quota", {
    method: "POST",
    body: {
      p_client_id: clientId,
      p_reason: reason,
      p_project_name: ACTIVATION_PROJECT,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return normalizeQuotaRow(row);
}

async function refundClientQuota(clientId, reason) {
  const rows = await supabaseRequest("/rpc/refund_client_quota", {
    method: "POST",
    body: {
      p_client_id: clientId,
      p_reason: reason,
      p_project_name: ACTIVATION_PROJECT,
    },
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return normalizeQuotaRow(row);
}

async function withQuota(clientId, reason, work) {
  if (!isActivationRequired()) {
    return {
      result: await work(),
      quota: null,
    };
  }

  const quota = await spendClientQuota(clientId, reason);
  try {
    return {
      result: await work(),
      quota,
    };
  } catch (error) {
    try {
      await refundClientQuota(clientId, `${reason}:refund`);
    } catch (refundError) {
      console.error("Quota refund failed:", refundError);
    }
    throw error;
  }
}

function attachQuota(payload, quota) {
  if (!quota) {
    return payload;
  }
  return {
    ...payload,
    quota,
  };
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ClientError(`${label}不能为空`);
  }
  if (value.length > maxLength) {
    throw new ClientError(`${label}内容过长`);
  }
  return value.trim();
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ClientError(`${label}格式无效或内容过长`);
  }
  return value.trim();
}

async function callOpenRouter(messages, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new Error("OpenRouter API Key 未配置");
    error.publicMessage = "AI 服务尚未配置，请先设置 OPENROUTER_API_KEY";
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 45_000
  );

  try {
    const requestBody = {
      model: options.model || process.env.OPENROUTER_MODEL || "openrouter/auto",
      messages,
      temperature: 0.7,
    };
    if (Array.isArray(options.tools) && options.tools.length) {
      requestBody.tools = options.tools;
    }
    if (Number.isInteger(options.maxToolCalls) && options.maxToolCalls > 0) {
      requestBody.max_tool_calls = options.maxToolCalls;
    }

    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": `http://localhost:${port}`,
        "X-Title": "ReadPage AI Reading Assistant",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      let upstreamMessage = "Unknown OpenRouter error";
      try {
        const upstreamError = await upstream.json();
        if (typeof upstreamError?.error?.message === "string") {
          upstreamMessage = upstreamError.error.message;
        }
      } catch (_error) {
        // Keep the fallback message when OpenRouter returns a non-JSON error.
      }
      console.error(`OpenRouter ${upstream.status}: ${upstreamMessage}`);
      const error = new Error(`OpenRouter returned ${upstream.status}`);
      error.publicMessage = "AI 服务暂时不可用，请稍后重试";
      throw error;
    }

    const data = await upstream.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const error = new Error("OpenRouter response has no content");
      error.publicMessage = "AI 返回了无效内容，请重试";
      throw error;
    }
    return content.trim();
  } catch (error) {
    if (error.name === "AbortError") {
      error.publicMessage = "AI 请求超时，请稍后重试";
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function streamOpenRouter(messages, options = {}, onDelta) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new Error("OpenRouter API Key 未配置");
    error.publicMessage = "AI 服务尚未配置，请先设置 OPENROUTER_API_KEY";
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 60_000
  );

  try {
    const requestBody = {
      model: options.model || process.env.OPENROUTER_MODEL || "openrouter/auto",
      messages,
      temperature: 0.7,
      stream: true,
    };

    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": `http://localhost:${port}`,
        "X-Title": "ReadPage AI Reading Assistant",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      let upstreamMessage = "Unknown OpenRouter error";
      try {
        const upstreamError = await upstream.json();
        if (typeof upstreamError?.error?.message === "string") {
          upstreamMessage = upstreamError.error.message;
        }
      } catch (_error) {
        // Keep the fallback message when OpenRouter returns a non-JSON error.
      }
      console.error(`OpenRouter ${upstream.status}: ${upstreamMessage}`);
      const error = new Error(`OpenRouter returned ${upstream.status}`);
      error.publicMessage = "AI 服务暂时不可用，请稍后重试";
      throw error;
    }

    if (!upstream.body) {
      const error = new Error("OpenRouter response has no stream body");
      error.publicMessage = "AI 返回了无效内容，请重试";
      throw error;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    const processPart = (part) => {
      const lines = part.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const data = line.slice(5).trimStart();
        if (!data || data === "[DONE]") {
          continue;
        }

        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_error) {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          content += delta;
          onDelta(delta);
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const part of parts) {
        processPart(part);
      }
    }

    const rest = decoder.decode();
    if (rest) {
      buffer += rest;
    }
    if (buffer.trim()) {
      processPart(buffer);
    }

    return content.trim();
  } catch (error) {
    if (error.name === "AbortError") {
      error.publicMessage = "AI 请求超时，请稍后重试";
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cleanJsonContent(content) {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return cleaned;
}

function parseJsonContent(content, label) {
  const cleaned = cleanJsonContent(content);
  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    const firstObject = cleaned.indexOf("{");
    const lastObject = cleaned.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      const objectSlice = cleaned.slice(firstObject, lastObject + 1);
      try {
        return JSON.parse(objectSlice);
      } catch (_objectError) {
        // Try an array payload below.
      }
    }

    const firstArray = cleaned.indexOf("[");
    const lastArray = cleaned.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      const arraySlice = cleaned.slice(firstArray, lastArray + 1);
      try {
        return JSON.parse(arraySlice);
      } catch (_arrayError) {
        // Fall through to the shared error path.
      }
    }

    console.error(`${label} is not JSON:`, cleaned.slice(0, 2_000));
    throw new Error(`${label} is not JSON`);
  }
}

function parseQuestions(content, expectedCount = QUESTIONS_PER_BATCH) {
  let parsed;
  try {
    parsed = parseJsonContent(content, "AI question response");
  } catch (error) {
    const cleaned = cleanJsonContent(content).trim();
    if (
      cleaned.startsWith('{"questions":[') &&
      cleaned.endsWith("}") &&
      !cleaned.endsWith("]}")
    ) {
      parsed = JSON.parse(`${cleaned.slice(0, -1)}]}`);
    } else {
      throw error;
    }
  }

  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions) || questions.length !== expectedCount) {
    throw new Error(
      `AI question response must contain ${expectedCount} questions`
    );
  }

  return questions.map((question) => ({
    tag: requiredString(question?.tag, "问题标签", 20),
    text: requiredString(question?.text, "问题", 180),
    answer: requiredString(question?.answer, "参考答案", 600),
  }));
}

function parseChatReply(content) {
  const parsed = parseJsonContent(content, "AI chat response");

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI chat response must be an object");
  }

  return {
    answer: requiredString(parsed.answer, "回答", 2_000),
    completed: parsed.completed === true,
  };
}

function parseStreamChatHeader(content) {
  const match = String(content || "").match(/COMPLETED:\s*(true|false)/i);
  return {
    completed: match ? match[1].toLowerCase() === "true" : false,
  };
}

function isPrefaceTitle(title) {
  return ["前言", "序言"].includes(String(title || "").trim());
}

function describeChapter(chapter, chapterTitle = "") {
  if (chapter === 0) {
    return chapterTitle || "前言/序言";
  }
  return `第 ${chapter} 章${chapterTitle ? `《${chapterTitle}》` : ""}`;
}

function parseChapters(content) {
  const parsed = parseJsonContent(content, "AI chapter response");

  const confidence = parsed?.confidence;
  if (confidence !== "high" && confidence !== "low") {
    throw new Error("AI chapter response has an invalid confidence");
  }
  const warning = optionalString(parsed?.warning, "目录提醒", 240);
  const chapters = parsed?.chapters;
  if (!Array.isArray(chapters)) {
    console.error(
      "AI chapter response has no chapters array:",
      cleanJsonContent(content).slice(0, 2_000)
    );
    throw new Error(
      `AI chapter response chapters must be an array, received ${
        chapters === null ? "null" : typeof chapters
      }`
    );
  }
  if (chapters.length < 1 || chapters.length > 200) {
    console.error(
      `AI chapter response returned ${chapters.length} chapters:`,
      cleanJsonContent(content).slice(0, 2_000)
    );
    throw new Error(
      `AI chapter response has ${chapters.length} chapters; expected 1 to 200`
    );
  }

  let nextBodyNumber = 1;
  let hasPreface = false;
  const normalizedChapters = chapters.map((chapter) => {
    const title = requiredString(chapter?.title, "章节名", 120),
      isPreface = isPrefaceTitle(title);
    if (isPreface) {
      if (hasPreface) {
        throw new Error("AI chapter response has duplicate preface chapters");
      }
      hasPreface = true;
    }
    return {
      number: isPreface ? 0 : nextBodyNumber++,
      title,
      summary: requiredString(chapter?.summary, "章节简介", 500),
      source: "ai",
    };
  });

  return {
    confidence,
    warning,
    chapters: normalizedChapters,
  };
}

async function handleChapters(request, response) {
  const body = await readJson(request);
  const clientId = requiredClientId(body.clientId);
  const title = requiredString(body.title, "书名", 80);
  const author = optionalString(body.author, "作者", 80);
  const { result, quota } = await withQuota(
    clientId,
    "chapters",
    async () => {
      const content = await callOpenRouter(
        [
          {
            role: "system",
            content: `你是谨慎的图书目录助手。请输出严格 JSON，不要 Markdown。
格式为 {"confidence":"high|low","warning":"给用户的简短核对提醒","chapters":[{"title":"章节名","summary":"章节简介"}]}。

要求：
1. 先联网搜索并核对公开目录信息；不要只凭模型记忆生成目录。
2. 如果联网结果无法可靠确认目录，必须将 confidence 设为 low，并在 warning 中提醒用户核对具体版本。
3. 可以在正式正文目录前加入一个“前言”或“序言”；正文从第一章开始，保持原有顺序，不加入推荐序、附录或致谢。
4. title 不包含章节序号。
5. summary 用 1–2 句话概括本章主题，最多 160 个汉字；不得编造无法确认的人物、情节、观点或引文。
6. 只有联网结果中多个可靠来源相互印证，且高度确信书籍及常见版本目录时 confidence 才能为 high，否则必须为 low。
7. 不确定时不要假装准确；warning 应明确说明可能存在版本差异并建议用户核对。confidence 为 high 时 warning 可以为空字符串。`,
          },
          {
            role: "user",
            content: `图书：《${title}》\n作者：${author || "未知"}`,
          },
        ],
        {
          model: process.env.OPENROUTER_CHAPTER_MODEL || "openai/gpt-5.4",
          tools: [
            {
              type: "openrouter:web_search",
              parameters: {
                engine: "auto",
                max_results: 5,
                max_total_results: 10,
                max_uses: 3,
                search_context_size: "medium",
              },
            },
          ],
          maxToolCalls: 3,
          timeoutMs: 90_000,
        },
      );
      return parseChapters(content);
    }
  );

  sendJson(response, 200, attachQuota(result, quota));
}

async function handleQuestions(request, response) {
  const body = await readJson(request);
  const clientId = requiredClientId(body.clientId);
  const title = requiredString(body.title, "书名", 80);
  const author = optionalString(body.author, "作者", 80);
  const chapter = Number(body.chapter);
  const chapterTitle = optionalString(body.chapterTitle, "章节名", 120);
  const context = optionalString(body.context, "章节内容", 20_000);
  const contextSource = body.contextSource || "none";
  const questionCount = QUESTIONS_PER_BATCH;
  if (!Number.isInteger(chapter) || chapter < 0 || chapter > 9999) {
    throw new ClientError("章节号无效");
  }
  if (!["ai-summary", "user", "none"].includes(contextSource)) {
    throw new ClientError("章节内容来源无效");
  }
  if (contextSource !== "none" && !context) {
    throw new ClientError("章节内容不能为空");
  }

  let grounding;
  if (contextSource === "user") {
    grounding = `以下是用户提供或校正的章节内容。只能依据它出题，不得补充其中没有的情节：\n${context}`;
  } else if (contextSource === "ai-summary") {
    grounding = `以下是未经用户核对的 AI 章节简介，可能因版本差异或模型幻觉而错误：\n${context}\n只能把它当作待核对线索。问题必须使用“请在本章中寻找”“请核对原文如何写”等审慎表达，不得把简介中的人物、事件或观点直接宣称为事实。`;
  } else {
    grounding =
      "没有可靠的章节正文或摘要。问题要引导用户回到本章查找证据；参考答案可以基于书名、作者、章节标题和常识给出概括性答案，但不得假装引用了原文逐字表述。";
  }
  const { result, quota } = await withQuota(
    clientId,
    "questions",
    async () => {
      const content = await callOpenRouter([
        {
          role: "system",
          content: `你是中文阅读教练。

任务：
为指定章节生成 ${questionCount} 道阅读理解题，并为每道题提供一个简短参考答案。

要求：
1. tag 依次为：信息定位、内容概括、证据判断。
2. 每题只问一个任务，答案应能用一句话、两点、一个例子或一处证据回答。
3. 不要问“你怎么看”“有什么启发”，不要剧透，不要编造原文没有的信息。
4. 没有可靠原文时，问题可以用“请在本章中寻找/核对……”这类寻读问法，但 answer 仍必须给出可直接看的参考答案。
5. answer 必须简短，直接回答问题，不要写“请核对”“请寻找”“回到原文查看”这类任务提示。
6. 如果没有正文，只能给概括性参考答案；可以写“参考答案：……”，但不要声称这是原文原句。

坏例子：
- 剧透：“作者是否指出了渐进主义、规避风险、自满等趋势？”
- 太笼统：“请定位作者用以解释两种进步形式的关键表述。”
- 太封闭：“本章是否描述了某次具体对话或事件？”
- 太长：“请核对他们的成长背景如何导致同一个词产生不同私人记忆。”
- 太简单：“作者引用了哪家公司的工作时长政策？”

好例子：
- “他们对同一个词有哪些相反的私人记忆与理解？”
- “作者提到的经典面试问题具体是如何表述的？”
- “作者回顾互联网泡沫时提到了哪些公司案例或历史事件？”
- “请整理作者总结的两项核心能力。”

好答案：
- “自控力并不是意志力硬扛，而是通过环境设计减少诱惑出现的机会。”
- “核心方法包括让坏习惯的线索不明显、增加行动阻力，并提前设计替代行为。”
- “证据通常来自对高自控力人群的研究：他们不是更会忍耐，而是更少进入需要忍耐的情境。”

坏答案：
- “请核对正文中定义自控力的句子。”
- “请根据本章小结梳理具体策略。”
- “请寻找相关心理学实验或调查数据。”

输出严格 JSON，不要 Markdown：
{"questions":[{"tag":"短标签","text":"问题","answer":"简短参考答案"}]}
每个问题对象只能包含 tag、text 和 answer。`,
        },
        {
          role: "user",
          content: `图书：《${title}》\n作者：${
            author || "未知"
          }\n章节：${describeChapter(chapter, chapterTitle)}\n${grounding}`,
        },
      ]);
      return {
        questions: parseQuestions(content, questionCount),
      };
    }
  );

  sendJson(response, 200, attachQuota(result, quota));
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const clientId = requiredClientId(body.clientId);
  const book = body.book && typeof body.book === "object" ? body.book : {};
  const title = requiredString(book.title, "书名", 80);
  const author = optionalString(book.author, "作者", 80);
  const chapter = Number(body.chapter);
  const chapterLabel = optionalString(body.chapterLabel, "章节信息", 140);
  const question = requiredString(body.question, "讨论问题", 300);
  if (!Array.isArray(body.messages) || body.messages.length < 1) {
    throw new ClientError("对话记录不能为空");
  }
  if (body.messages.length > 60) {
    throw new ClientError("对话记录过长，请新建对话");
  }
  const chapterContext =
    Number.isInteger(chapter) && chapter >= 0
      ? chapterLabel || describeChapter(chapter)
      : chapterLabel || "章节未知";

  const messages = body.messages.map((message) => {
    const role = message?.role === "ai" ? "assistant" : message?.role;
    if (role !== "user" && role !== "assistant") {
      throw new ClientError("对话角色无效");
    }
    return {
      role,
      content: requiredString(message.text, "对话内容", 2_000),
    };
  });

  const systemMessage = {
    role: "system",
    content: `你是耐心、简洁的中文阅读教练。

讨论背景：
正在讨论《${title}》（作者：${author || "未知"}）的问题：“${question}”。
问题来源：${chapterContext}。

核心目标：
每一次对话只围绕当前传来的问题展开：“${question}”。
帮助用户把这个问题讨论清楚，而不是扩展到新的主题。

回应要求：
1. 结合完整对话，先简短回应用户已经提到的内容。
2. 判断用户是否已经把当前问题回答完整。
3. 如果还没有回答完整，给出一个可执行的重读线索，引导用户定位相关段落、对话、行动、关键词或前后变化，并继续追问一个只服务于当前问题的自然问题。
4. 如果已经回答完整，简洁确认或补充当前问题的结论，不要继续追问。
5. 如果用户还没读相关内容，明确建议先读哪类内容。当用户表示不知道或者提问时，你再告诉用户答案。
6. 不要虚构无法确认的书中细节，也不要主动开启当前问题之外的新话题。

输出要求：
第一行必须是 COMPLETED: true 或 COMPLETED: false。
第二行必须是 ANSWER:。
从第三行开始输出直接给用户看的纯文本回答，不要 Markdown，不要提到 COMPLETED、ANSWER 或字段名。
COMPLETED 表示用户是否已经把当前问题回答完整；如果你还需要继续追问或引导重读，就必须为 false。`,
  };

  let answer = "";
  let rawContent = "";
  let headerBuffer = "";
  let answerStarted = false;
  let completed = false;
  let streamStarted = false;

  const startStream = () => {
    if (streamStarted) {
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    });
    response.write("\n");
    streamStarted = true;
  };

  const flushAnswerChunk = (chunk) => {
    if (!chunk) {
      return;
    }

    answer += chunk;
    sendSse(response, "chunk", {
      text: chunk,
    });
  };

  const consumeDelta = (delta) => {
    rawContent += delta;

    if (answerStarted) {
      flushAnswerChunk(delta);
      return;
    }

    headerBuffer += delta;
    const markerMatch = headerBuffer.match(/(?:^|\r?\n)ANSWER:\s*(?:\r?\n)?/i);
    if (!markerMatch || markerMatch.index === undefined) {
      return;
    }

    const beforeAnswer = headerBuffer.slice(0, markerMatch.index);
    const parsedHeader = parseStreamChatHeader(beforeAnswer);
    completed = parsedHeader.completed;
    answerStarted = true;
    flushAnswerChunk(
      headerBuffer.slice(markerMatch.index + markerMatch[0].length)
    );
    headerBuffer = "";
  };

  let quota = null;
  try {
    const quotaResult = await withQuota(clientId, "chat", async () => {
      startStream();
      await streamOpenRouter([
        systemMessage,
        ...messages,
      ], {}, consumeDelta);
    });
    quota = quotaResult.quota;
  } catch (error) {
    if (response.headersSent) {
      sendSse(response, "error", {
        error: error.publicMessage || "AI 服务请求失败，请稍后重试",
      });
      response.end();
      return;
    }
    throw error;
  }

  if (!answerStarted && rawContent) {
    const parsedHeader = parseStreamChatHeader(rawContent);
    completed = parsedHeader.completed;
    flushAnswerChunk(
      rawContent
        .replace(/COMPLETED:\s*(true|false)\s*/i, "")
        .replace(/ANSWER:\s*/i, "")
        .trim()
    );
  }

  if (!answer.trim()) {
    sendSse(response, "error", {
      error: "AI 返回了无效内容，请重试",
    });
    response.end();
    return;
  }

  sendSse(
    response,
    "done",
    attachQuota(
      {
        answer: answer.trim(),
        completed,
      },
      quota
    )
  );
  response.end();
}

async function handleQuota(request, response) {
  const body = await readJson(request);
  const clientId = requiredClientId(body.clientId);
  if (!isActivationRequired()) {
    sendJson(response, 200, {
      enabled: false,
      quota: null,
    });
    return;
  }

  sendJson(response, 200, {
    enabled: true,
    quota: await getClientQuota(clientId),
  });
}

async function handleRedeemCode(request, response) {
  const body = await readJson(request);
  const clientId = requiredClientId(body.clientId);
  const code = normalizeActivationCode(body.code);
  if (!isActivationRequired()) {
    sendJson(response, 200, {
      enabled: false,
      quota: null,
      message: "当前未开启激活码限制",
    });
    return;
  }

  const quota = await redeemActivationCode(clientId, code);
  sendJson(response, 200, {
    enabled: true,
    quota,
    message: "兑换成功",
  });
}

function serveIndex(response) {
  fs.readFile(path.join(ROOT, "index.html"), (error, content) => {
    if (error) {
      sendJson(response, 500, { error: "页面读取失败" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

function serveIcon(response) {
  fs.readFile(path.join(ROOT, "icon.svg"), (error, content) => {
    if (error) {
      sendJson(response, 500, { error: "图标读取失败" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const startedAt = process.hrtime.bigint();
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  );

  response.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(
      `${request.method} ${requestUrl.pathname} ${
        response.statusCode
      } ${durationMs.toFixed(1)}ms`
    );
  });

  try {
    const url = requestUrl;
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      serveIndex(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/icon.svg") {
      serveIcon(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/quota") {
      await handleQuota(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/redeem-code") {
      await handleRedeemCode(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/questions") {
      await handleQuestions(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chapters") {
      await handleChapters(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }
    sendJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    const status = error instanceof ClientError ? 400 : 502;
    const message =
      error instanceof ClientError
        ? error.message
        : error.publicMessage || "AI 服务请求失败，请稍后重试";
    if (!(error instanceof ClientError)) {
      console.error(error);
    }
    if (!response.headersSent) {
      sendJson(response, status, { error: message });
    }
  }
});

server.on("error", (error) => {
  console.error(`服务器启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`读页已启动：http://localhost:${port}`);
});
