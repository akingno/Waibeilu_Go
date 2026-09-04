import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOST = "127.0.0.1";
const PORT = 8080;
const ROOT = process.cwd();
const clients = new Set();

const db = new DatabaseSync(join(ROOT, "chat.db"));
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, content TEXT, created_at DATETIME)");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim().split("="))
      .filter(([key]) => key)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]),
  );
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function formBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function serveFile(res, relativePath) {
  const safePath = normalize(relativePath).replace(/^(\.\.(\\|\/|$))+/, "");
  const filePaths = [join(ROOT, safePath), join(ROOT, "public", safePath)];
  const allowed = [".html", ".css", ".js", ".json", ".txt", ".svg", ".png", ".webp"];
  if (!allowed.includes(extname(safePath).toLowerCase())) {
    text(res, 404, "Not Found");
    return;
  }
  for (const filePath of filePaths) {
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
      res.end(data);
      return;
    } catch {
      // Try the next configured static-file root.
    }
  }

  try {
    const data = await readFile(join(ROOT, "404.html"));
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  } catch {
    text(res, 404, "Not Found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/login") {
      const form = await formBody(req);
      const username = (form.get("username") || "").trim();
      const password = form.get("password") || "";
      const user = db.prepare("SELECT password FROM users WHERE username = ?").get(username);
      if (!user || user.password !== password) {
        text(res, 401, "用户名或密码错误");
        return;
      }
      res.writeHead(302, {
        Location: "/chat.html",
        "Set-Cookie": `username=${encodeURIComponent(username)}; Path=/; Max-Age=259200; SameSite=Lax`,
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const form = await formBody(req);
      const username = (form.get("username") || "").trim();
      const password = form.get("password") || "";
      if (username.length < 2 || password.length < 6) {
        text(res, 400, "账号至少 2 位，密码至少 6 位");
        return;
      }
      try {
        db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, password);
      } catch {
        text(res, 409, "注册失败：用户名可能已存在");
        return;
      }
      redirect(res, "/");
      return;
    }

    if (req.method !== "GET") {
      text(res, 405, "Method Not Allowed");
      return;
    }

    if (url.pathname === "/") {
      if (cookies(req).username) redirect(res, "/chat.html");
      else await serveFile(res, "index.html");
      return;
    }

    if (url.pathname === "/chat.html" && !cookies(req).username) {
      redirect(res, "/");
      return;
    }

    const relativePath = decodeURIComponent(url.pathname.slice(1));
    await serveFile(res, relativePath);
  } catch (error) {
    console.error(error);
    text(res, 500, "服务器内部错误");
  }
});

function frame(payload, opcode = 0x1) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(frame(JSON.stringify(message)));
}

function broadcast(message) {
  for (const socket of clients) send(socket, message);
}

function broadcastCount() {
  broadcast({ type: "count", count: clients.size });
}

function decodeFrames(state, chunk, onMessage, onClose) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const bigLength = state.buffer.readBigUInt64BE(2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) return onClose();
      length = Number(bigLength);
      offset = 10;
    }

    const maskBytes = masked ? 4 : 0;
    if (state.buffer.length < offset + maskBytes + length) return;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskBytes;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);

    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    if (opcode === 0x8) return onClose();
    if (opcode === 0x9) {
      state.socket.write(frame(payload, 0xA));
      continue;
    }
    if (opcode === 0x1) onMessage(payload.toString("utf8"));
  }
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const username = cookies(req).username;
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/ws" || !username || !key) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  clients.add(socket);
  const state = { buffer: Buffer.alloc(0), socket };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clients.delete(socket);
    socket.destroy();
    broadcastCount();
  };

  const history = db
    .prepare("SELECT sender, content, created_at FROM messages ORDER BY id DESC LIMIT 100")
    .all()
    .reverse();
  for (const message of history) send(socket, { type: "chat", ...message });
  broadcastCount();

  socket.on("data", (chunk) =>
    decodeFrames(
      state,
      chunk,
      (raw) => {
        try {
          const incoming = JSON.parse(raw);
          const content = String(incoming.content || "").trim();
          if (!content || content.length > 4000) return;
          const createdAt = new Date().toISOString();
          db.prepare("INSERT INTO messages (sender, content, created_at) VALUES (?, ?, ?)").run(
            username,
            content,
            createdAt,
          );
          broadcast({ type: "chat", sender: username, content, created_at: createdAt });
        } catch (error) {
          console.error("无效的 WebSocket 消息", error.message);
        }
      },
      close,
    ),
  );
  socket.on("end", close);
  socket.on("close", close);
  socket.on("error", close);
});

server.listen(PORT, HOST, () => {
  console.log(`外北陆热线已启动：http://${HOST}:${PORT}`);
  console.log("按 Ctrl+C 停止服务");
});

function shutdown() {
  for (const socket of clients) socket.destroy();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
