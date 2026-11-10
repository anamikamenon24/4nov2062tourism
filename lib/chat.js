const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MAX_BODY_BYTES = 64 * 1024;
const SYSTEM_INSTRUCTIONS = [
  "You are a friendly, practical tourism assistant.",
  "Help travelers plan destinations, itineraries, transport, food, culture, and packing.",
  "Ask concise follow-up questions when destination, dates, interests, or budget are missing.",
  "Do not claim live availability, current opening hours, prices, visa rules, or safety conditions; encourage checking official sources for time-sensitive details.",
  "Be inclusive of different budgets and mobility needs. Keep answers well organized and actionable."
].join(" ");

function readDotEnvFile() {
  const file = path.join(ROOT, ".env.txt");
  if (!fs.existsSync(file)) return {};

  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    values[name] = value;
  }
  return values;
}

function readConfig() {
  const values = { ...readDotEnvFile(), ...process.env };
  const endpoint = values.AZURE_OPENAI_ENDPOINT;
  const apiKey = values.AZURE_OPENAI_API_KEY;
  const deployment = values.AZURE_OPENAI_DEPLOYMENT;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("Missing AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, or AZURE_OPENAI_DEPLOYMENT.");
  }

  const useModelsApi = /\/models(?:\/|$)/i.test(endpoint) || endpoint.includes("services.ai.azure.com");
  const apiVersion = useModelsApi ? "2024-05-01-preview" : values.AZURE_OPENAI_API_VERSION;
  let baseEndpoint = endpoint.replace(/\/+$/, "");

  if (useModelsApi) {
    baseEndpoint = baseEndpoint
      .replace(/\/openai\/v1(?:\/responses)?$/i, "")
      .replace(/\/models$/i, "");
  } else {
    baseEndpoint = baseEndpoint.replace(/\/responses$/i, "");
  }

  return { endpoint: baseEndpoint, apiKey, deployment, apiVersion, useModelsApi };
}

function sendJson(response, status, payload) {
  if (typeof response.status === "function" && typeof response.json === "function") {
    return response.status(status).json(payload);
  }

  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  if (request.body !== undefined) {
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body;
    if (typeof body !== "string") {
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
        throw new Error("Request is too large.");
      }
      return Promise.resolve(body);
    }
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error("Request is too large.");
    }
    try {
      return Promise.resolve(JSON.parse(body));
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Request is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function getResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const content = data.choices[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
    }
  }

  const parts = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function handleChat(request, response) {
  if (request.method !== "POST") {
    if (typeof response.setHeader === "function") response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    const status = error.message === "Request is too large." ? 413 : 400;
    return sendJson(response, status, { error: error.message });
  }

  const messages = body && body.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > 24 ||
    messages.some((message) =>
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > 4000
    )
  ) {
    return sendJson(response, 400, { error: "Please send a valid chat with up to 24 messages." });
  }

  try {
    const config = readConfig();
    const requestUrl = config.useModelsApi
      ? new URL(`${config.endpoint}/models/chat/completions`)
      : new URL(`${config.endpoint}/responses`);

    if (config.apiVersion) requestUrl.searchParams.set("api-version", config.apiVersion);

    const payload = config.useModelsApi
      ? {
          model: config.deployment,
          messages: [{ role: "system", content: SYSTEM_INSTRUCTIONS }, ...messages],
          max_completion_tokens: 2000,
          reasoning_effort: "low"
        }
      : {
          model: config.deployment,
          instructions: SYSTEM_INSTRUCTIONS,
          input: messages
        };

    const upstream = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Azure AI API returned status", upstream.status, JSON.stringify(data).slice(0, 1000));
      return sendJson(response, 502, { error: "The tourism assistant could not reach Azure AI. Please try again shortly." });
    }

    const text = getResponseText(data);
    if (!text) {
      console.error("Azure AI API returned no text output.", JSON.stringify(data).slice(0, 1000));
      return sendJson(response, 502, { error: "The assistant returned an empty reply. Please try again." });
    }
    return sendJson(response, 200, { reply: text });
  } catch (error) {
    console.error("Tourism chat request failed:", error.message);
    const isConfigurationError = error.message.startsWith("Missing AZURE_OPENAI_");
    const status = isConfigurationError ? 503 : 502;
    const message = isConfigurationError
      ? "The AI service is not configured. Add its environment variables in the Vercel project settings."
      : "The tourism assistant could not reach Azure AI. Please try again shortly.";
    return sendJson(response, status, { error: message });
  }
}

module.exports = { handleChat };
