import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { MAX_PHOTO_BYTES, preparePhoto, readPhoto } from "../photos.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sample = format => sharp({ create: { width: 800, height: 600, channels: 3, background: "#20a0c0" } }).toFormat(format).toBuffer();

test("valid formats produce real, bounded WebP thumbnails and keep orientation", async () => {
  for (const [format, type] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]]) {
    const photo = await preparePhoto(await sample(format), type, `图片.${format}`);
    const thumb = await sharp(photo.thumbnail).metadata();
    assert.equal(thumb.format, "webp");
    assert.equal(thumb.width, 480);
    assert.equal(thumb.height, 360);
    assert.equal(photo.width, 800);
  }
  const rotated = await sharp(await sample("jpeg")).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const photo = await preparePhoto(rotated, "image/jpeg", "portrait.jpg");
  assert.equal(photo.width, 600);
  assert.equal(photo.height, 800);
  assert.equal((await sharp(photo.thumbnail).metadata()).height, 480);
});

test("reject empty, oversized, spoofed, unsupported and corrupt photos", async () => {
  await assert.rejects(preparePhoto(Buffer.alloc(0), "image/png"), { status: 400 });
  await assert.rejects(preparePhoto(Buffer.alloc(MAX_PHOTO_BYTES), "image/png"), { status: 413 });
  await assert.rejects(preparePhoto(await sample("png"), "image/jpeg"), { status: 415 });
  await assert.rejects(preparePhoto(Buffer.from("HEIC"), "image/heic"), { status: 415 });
  await assert.rejects(preparePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), "image/png"), { status: 415 });
  const jpeg = await sample("jpeg");
  await assert.rejects(preparePhoto(jpeg.subarray(0, jpeg.length / 2), "image/jpeg"), { status: 400 });
  const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(preparePhoto(huge, "image/png"), { status: 400 });
});

test("streamed uploads enforce the strict limit without Content-Length", async () => {
  const accepted = new PassThrough();
  const result = readPhoto(accepted);
  accepted.end(Buffer.alloc(MAX_PHOTO_BYTES - 1));
  assert.equal((await result).length, MAX_PHOTO_BYTES - 1);
  const rejected = new PassThrough();
  const failure = assert.rejects(readPhoto(rejected), { status: 413 });
  rejected.write(Buffer.alloc(MAX_PHOTO_BYTES - 1));
  rejected.end(Buffer.alloc(1));
  await failure;
});

async function startServer(directory) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root, env: { ...process.env, PORT: "0", CHAT_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server startup timed out: ${errors}`)); }, 10000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", () => { clearTimeout(timeout); reject(new Error(`Server exited: ${errors}`)); });
    child.stdout.on("data", data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  return { url, async stop() { const exited = once(child, "exit"); child.kill(); await exited; } };
}

async function connectChat(url, cookie) {
  const req = request(`${url}/ws`, { headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Cookie: cookie,
  } });
  const upgraded = once(req, "upgrade");
  req.end();
  const [, socket, head] = await upgraded;
  const messages = [];
  let pending = head;
  function parse(chunk = Buffer.alloc(0)) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      let length = pending[1] & 127;
      let offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
      if (pending.length < offset + length) return;
      messages.push(JSON.parse(pending.subarray(offset, offset + length).toString()));
      pending = pending.subarray(offset + length);
    }
  }
  socket.on("data", parse);
  parse();
  return {
    close: () => socket.destroy(),
    async waitFor(predicate) {
      const timeout = Date.now() + 5000;
      while (Date.now() < timeout) {
        const message = messages.find(predicate);
        if (message) return message;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("Expected chat message not received");
    },
  };
}

test("upload, live delivery, history, download, access checks and restart persistence", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "waibeilu-photos-"));
  const previous = new DatabaseSync(join(directory, "chat.db"));
  previous.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, content TEXT, created_at DATETIME)");
  previous.prepare("INSERT INTO messages (sender, content, created_at) VALUES (?, ?, ?)").run("old-user", "existing message", new Date().toISOString());
  previous.close();
  let server;
  const chats = [];
  try {
    server = await startServer(directory);
    const account = new URLSearchParams({ username: "photo-test", password: "test-only-password" });
    await fetch(`${server.url}/api/register`, { method: "POST", body: account, redirect: "manual" });
    const login = await fetch(`${server.url}/api/login`, { method: "POST", body: account, redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const first = await connectChat(server.url, cookie);
    const second = await connectChat(server.url, cookie);
    chats.push(first, second);
    await first.waitFor(message => message.content === "existing message");
    const bytes = await sample("png");
    const headers = { Cookie: cookie, "Content-Type": "image/png", "X-File-Name": encodeURIComponent("测试图片.png") };
    const post = (body = bytes, extra = {}) => fetch(`${server.url}/api/photos`, { method: "POST", headers: { ...headers, ...extra }, body });
    assert.equal((await post(bytes, { Cookie: "" })).status, 401);
    assert.equal((await post(bytes, { Origin: "https://another.example" })).status, 403);
    assert.equal((await post(bytes, { "Content-Type": "image/jpeg" })).status, 415);
    assert.equal((await post(Buffer.alloc(MAX_PHOTO_BYTES))).status, 413);
    const response = await post();
    assert.equal(response.status, 201, await response.clone().text());
    const message = await response.json();
    assert.equal(message.image.filename, "测试图片.png");
    assert.deepEqual(await first.waitFor(item => item.id === message.id), message);
    assert.deepEqual(await second.waitFor(item => item.id === message.id), message);
    for (const route of [message.image.url, message.image.thumbnail, message.image.download]) {
      assert.equal((await fetch(server.url + route)).status, 401);
      assert.equal((await fetch(server.url + route, { headers: { Cookie: "username=nonexistent" } })).status, 401);
    }
    const thumb = await fetch(server.url + message.image.thumbnail, { headers });
    assert.equal(thumb.headers.get("content-type"), "image/webp");
    assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width, 480);
    const original = await fetch(server.url + message.image.download, { headers });
    assert.match(original.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const id = message.image.url.split("/").pop();
    assert.equal((await fetch(`${server.url}/data/uploads/${id}.webp`)).status, 404);
    chats.forEach(chat => chat.close());
    await server.stop();
    server = await startServer(directory);
    const history = await connectChat(server.url, cookie);
    chats.push(history);
    assert.deepEqual(await history.waitFor(item => item.id === message.id), message);
    assert.equal((await fetch(server.url + message.image.url, { headers })).status, 200);
  } finally {
    chats.forEach(chat => chat.close());
    if (server) await server.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), "waibeilu-photos-")));
    await rm(directory, { recursive: true, force: true });
  }
});
