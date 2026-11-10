const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { handleChat } = require("./lib/chat");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/api/chat") {
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
