const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
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
  const apiVersion = values.AZURE_OPENAI_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    throw new Error("Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT in your environment or .env.txt.");
  }

  const cleanedEndpoint = endpoint.replace(/\/+$/, "").replace(/\/responses$/i, "");
  return {
    endpoint: cleanedEndpoint,
    apiKey,
    deployment,
    apiVersion
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
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
  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
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
    const url = new URL(`${config.endpoint}/responses`);
    if (config.apiVersion) {
      url.searchParams.set("api-version", config.apiVersion);
    }

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey
      },
      body: JSON.stringify({
        model: config.deployment,
        instructions: SYSTEM_INSTRUCTIONS,
        input: messages
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Azure Responses API returned status", upstream.status);
      return sendJson(response, 502, { error: "The tourism assistant could not reach Azure AI. Please try again shortly." });
    }

    const text = getResponseText(data);
    if (!text) {
      console.error("Azure Responses API returned no text output.");
      return sendJson(response, 502, { error: "The assistant returned an empty reply. Please try again." });
    }
    return sendJson(response, 200, { reply: text });
  } catch (error) {
    console.error("Tourism chat request failed:", error.message);
    return sendJson(response, 500, { error: "The tourism assistant is not configured correctly. Check the server configuration and try again." });
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "POST" && url.pathname === "/api/chat") {
    void handleChat(request, response);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(path.join(ROOT, "public", "index.html")).pipe(response);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tourism bot is ready at http://localhost:${PORT}`);
});
