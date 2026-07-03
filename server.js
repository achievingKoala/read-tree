const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const MAX_BODY_BYTES = 250_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

loadEnv(path.join(ROOT, ".env"));

const port = parsePort(process.env.PORT);

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

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
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

async function callOpenRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new Error("OpenRouter API Key 未配置");
    error.publicMessage = "AI 服务尚未配置，请先设置 OPENROUTER_API_KEY";
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": `http://localhost:${port}`,
        "X-Title": "ReadPage AI Reading Assistant",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openrouter/auto",
        messages,
        temperature: 0.7,
      }),
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

function parseQuestions(content) {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_error) {
    throw new Error("AI question response is not JSON");
  }

  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions) || questions.length !== 4) {
    throw new Error("AI question response must contain four questions");
  }

  return questions.map((question) => ({
    tag: requiredString(question?.tag, "问题标签", 20),
    text: requiredString(question?.text, "问题", 180),
    prompt: requiredString(question?.prompt, "引导语", 240),
  }));
}

function parseChapters(content) {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_error) {
    throw new Error("AI chapter response is not JSON");
  }

  const chapters = Array.isArray(parsed) ? parsed : parsed.chapters;
  if (
    !Array.isArray(chapters) ||
    chapters.length < 1 ||
    chapters.length > 200
  ) {
    throw new Error("AI chapter response has an invalid chapter count");
  }

  return chapters.map((chapter, index) => ({
    number: index + 1,
    title: requiredString(chapter?.title, "章节名", 120),
  }));
}

async function handleChapters(request, response) {
  const body = await readJson(request);
  const title = requiredString(body.title, "书名", 80);
  const author = optionalString(body.author, "作者", 80);
  const content = await callOpenRouter([
    {
      role: "system",
      content:
        '你是图书目录助手。请输出严格 JSON，不要 Markdown，格式为 {"chapters":[{"title":"章节名"}]}。列出该书从第一章开始的完整正式章节目录，保持原有顺序，不要加入序言、推荐序、附录、致谢等非正文章节。不要输出章节序号，title 只放章节名称。如果无法可靠确认该书的章节目录，也必须返回最常见中文版本的目录，不要解释。',
    },
    {
      role: "user",
      content: `图书：《${title}》\n作者：${author || "未知"}`,
    },
  ]);

  sendJson(response, 200, { chapters: parseChapters(content) });
}

async function handleQuestions(request, response) {
  const body = await readJson(request);
  const title = requiredString(body.title, "书名", 80);
  const author = optionalString(body.author, "作者", 80);
  const chapter = Number(body.chapter);
  const chapterTitle = optionalString(body.chapterTitle, "章节名", 120);
  const context = optionalString(body.context, "章节内容", 20_000);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 9999) {
    throw new ClientError("章节号无效");
  }

  const grounding = context
    ? `以下是用户提供的章节内容或摘要。只能依据它出题，不得补充其中没有的情节：\n${context}`
    : "用户没有提供章节内容。可以依据常识生成开放性问题，但不要声称具体情节一定存在，并注意不同版本的章节划分可能不同。";
  const content = await callOpenRouter([
    {
      role: "system",
      content:
        '你是中文阅读教练。请输出严格 JSON，不要 Markdown。格式为 {"questions":[{"tag":"短标签","text":"问题","prompt":"引导用户回答的提示"}]}，questions 必须恰好 4 项，自由选择你认为最有价值的问题角度。',
    },
    {
      role: "user",
      content: `图书：《${title}》\n作者：${author || "未知"}\n章节：第 ${chapter} 章${chapterTitle ? `《${chapterTitle}》` : ""}\n${grounding}`,
    },
  ]);

  sendJson(response, 200, { questions: parseQuestions(content) });
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const book = body.book && typeof body.book === "object" ? body.book : {};
  const title = requiredString(book.title, "书名", 80);
  const author = optionalString(book.author, "作者", 80);
  const question = requiredString(body.question, "讨论问题", 300);
  if (!Array.isArray(body.messages) || body.messages.length < 1) {
    throw new ClientError("对话记录不能为空");
  }
  if (body.messages.length > 60) {
    throw new ClientError("对话记录过长，请新建对话");
  }

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

  const answer = await callOpenRouter([
    {
      role: "system",
      content: `你是耐心、简洁的中文阅读教练。返回中不要出现markdown ，直接返回纯文本  正在讨论《${title}》（作者：${author || "未知"}）的问题：“${question}”。结合完整对话回应用户，解释要具体，并用一个自然的问题鼓励继续思考。不要虚构无法确认的书中细节。`,
    },
    ...messages,
  ]);

  sendJson(response, 200, { answer });
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

const server = http.createServer(async (request, response) => {
  const startedAt = process.hrtime.bigint();
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`,
  );

  response.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(
      `${request.method} ${requestUrl.pathname} ${response.statusCode} ${durationMs.toFixed(1)}ms`,
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

server.listen(port, "127.0.0.1", () => {
  console.log(`读页已启动：http://localhost:${port}`);
});
