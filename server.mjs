import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_PHOTO_BYTES, PHOTO_TYPES, PhotoError, readPhoto, preparePhoto } from "./photos.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();
const DATA_DIR = resolve(process.env.CHAT_DATA_DIR || join(ROOT, "data"));
const PHOTO_DIR = join(DATA_DIR, "uploads");
await mkdir(PHOTO_DIR, { recursive: true });
const clients = new Map();
let uploadsInProgress = 0;

const db = new DatabaseSync(process.env.CHAT_DATA_DIR ? join(DATA_DIR, "chat.db") : join(ROOT, "chat.db"));
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, content TEXT, created_at DATETIME)");
if (!db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "image_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN image_id TEXT");
}
db.exec(`CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL,
  extension TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL
)`);

function messageToWire(message) {
  const { image_id, ...fields } = message;
  const image = image_id ? db.prepare("SELECT * FROM images WHERE id = ?").get(image_id) : null;
  return {
    type: "chat", ...fields,
    ...(image && { image: {
      filename: image.filename, width: image.width, height: image.height,
      url: `/api/photos/${image.id}`, thumbnail: `/api/photos/${image.id}/thumbnail`,
      download: `/api/photos/${image.id}/download`,
    } }),
  };
}

function photoUser(req) {
  const username = cookies(req).username;
  return username && db.prepare("SELECT username FROM users WHERE username = ?").get(username)?.username;
}

async function uploadPhoto(req, res) {
  const username = photoUser(req);
  if (!username) throw new PhotoError(401, "登录已失效，请重新登录后上传");
  if (req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
    throw new PhotoError(403, "请从聊天室页面上传图片");
  }
  const contentType = (req.headers["content-type"] || "").split(";")[0].toLowerCase();
  if (!PHOTO_TYPES.has(contentType)) throw new PhotoError(415, "仅支持 JPG、PNG 和 WebP 图片");
  if (Number(req.headers["content-length"]) >= MAX_PHOTO_BYTES) throw new PhotoError(413, "请选择小于 6MB 的图片");
  if (uploadsInProgress >= 2) throw new PhotoError(503, "当前上传人数较多，请稍后重试");
  let name;
  try { name = decodeURIComponent(req.headers["x-file-name"] || "photo"); }
  catch { throw new PhotoError(400, "图片文件名无效"); }
  uploadsInProgress++;
  const id = randomUUID();
  const originalPath = join(PHOTO_DIR, id);
  const thumbnailPath = join(PHOTO_DIR, `${id}.webp`);
  let committed = false;
  try {
    const bytes = await readPhoto(req);
    const photo = await preparePhoto(bytes, contentType, name);
    await writeFile(originalPath, bytes, { flag: "wx" });
    await writeFile(thumbnailPath, photo.thumbnail, { flag: "wx" });
    const created_at = new Date().toISOString();
    let messageId;
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO images VALUES (?, ?, ?, ?, ?, ?)").run(id, photo.filename, photo.mime, photo.extension, photo.width, photo.height);
      messageId = Number(db.prepare("INSERT INTO messages (sender, content, created_at, image_id) VALUES (?, '', ?, ?)").run(username, created_at, id).lastInsertRowid);
      db.exec("COMMIT");
      committed = true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const message = messageToWire({ id: messageId, sender: username, content: "", created_at, image_id: id });
    broadcast(message);
    res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(message));
  } finally {
    uploadsInProgress--;
    if (!committed) await Promise.allSettled([unlink(originalPath), unlink(thumbnailPath)]);
  }
}

async function servePhoto(req, res, id, variant) {
  if (!photoUser(req)) throw new PhotoError(401, "请先登录后查看图片");
  const photo = db.prepare("SELECT * FROM images WHERE id = ?").get(id);
  if (!photo) throw new PhotoError(404, "图片不存在");
  let bytes;
  try { bytes = await readFile(join(PHOTO_DIR, variant === "thumbnail" ? `${id}.webp` : id)); }
  catch (error) {
    if (error.code === "ENOENT") throw new PhotoError(404, "图片不存在");
    throw error;
  }
  const headers = {
    "Content-Type": variant === "thumbnail" ? "image/webp" : photo.mime,
    "Content-Length": bytes.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
  };
  if (variant === "download") {
    const filename = encodeURIComponent(photo.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    headers["Content-Disposition"] = `attachment; filename="photo.${photo.extension}"; filename*=UTF-8''${filename}`;
  }
  res.writeHead(200, headers);
  res.end(bytes);
}

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
  const safePath = relativePath.replace(/\\/g, "/");
  // Only public assets and the existing root pages are static files. Uploaded
  // photos must pass through the authenticated photo routes, even thumbnails.
  if (safePath.split("/").some(part => part.startsWith(".")) || safePath.startsWith("/")) {
    text(res, 404, "Not Found");
    return;
  }
  const filePaths = [join(ROOT, "public", safePath)];
  if (/^[\w-]+\.(html|css)$/.test(safePath) || /^components\/[\w-]+\.html$/.test(safePath)) {
    filePaths.unshift(join(ROOT, safePath));
  }
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
    if (req.method === "POST" && url.pathname === "/api/photos") {
      await uploadPhoto(req, res);
      return;
    }
    const photoRoute = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})(?:\/(thumbnail|download))?$/);
    if (req.method === "GET" && photoRoute) {
      await servePhoto(req, res, photoRoute[1], photoRoute[2]);
      return;
    }
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
    if (error instanceof PhotoError) {
      req.resume();
      text(res, error.status, error.message);
      return;
    }
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
  for (const socket of clients.keys()) send(socket, message);
}

function broadcastCount() {
  const users = [...new Set(clients.values())].sort();
  broadcast({ type: "count", count: users.length, users });
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

  clients.set(socket, username);
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
    .prepare("SELECT id, sender, content, created_at, image_id FROM messages ORDER BY id DESC LIMIT 100")
    .all()
    .reverse();
  for (const message of history) send(socket, messageToWire(message));
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
          const result = db.prepare("INSERT INTO messages (sender, content, created_at) VALUES (?, ?, ?)").run(
            username,
            content,
            createdAt,
          );
          broadcast({ type: "chat", id: Number(result.lastInsertRowid), sender: username, content, created_at: createdAt });
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
  console.log(`外北陆热线已启动：http://${HOST}:${server.address().port}`);
  console.log("按 Ctrl+C 停止服务");
});

function shutdown() {
  for (const socket of clients.keys()) socket.destroy();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
