import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../chat.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/chat-photos.js', import.meta.url), 'utf8');
const message = { id: 123, type: 'chat', sender: 'test', content: '', created_at: '2026-10-09T12:00:00Z', image: {
  filename: 'photo.png', width: 800, height: 600, url: '/api/photos/test',
  thumbnail: '/api/photos/test/thumbnail', download: '/api/photos/test/download'
} };
function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/chat.html' });
  const { window: w } = dom;
  const requests = [], revoked = [];
  w.URL.createObjectURL = () => 'blob:test-photo';
  w.URL.revokeObjectURL = url => revoked.push(url);
  class Request extends w.EventTarget {
    constructor() { super(); this.upload = new w.EventTarget(); this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
    respond(status, body) {
      this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.dispatchEvent(new w.Event('load')); this.dispatchEvent(new w.Event('loadend'));
    }
  }
  w.XMLHttpRequest = Request;
  const el = id => w.document.getElementById(id);
  el('photoViewer').showModal = () => el('photoViewer').setAttribute('open', '');
  el('photoViewer').close = () => { el('photoViewer').removeAttribute('open'); el('photoViewer').dispatchEvent(new w.Event('close')); };
  w.eval(script);
  const select = (name = 'photo.png', type = 'image/png', size = 100) => {
    const file = new w.File([new Uint8Array(size)], name, { type });
    Object.defineProperty(el('photoInput'), 'files', { configurable: true, value: [file] });
    el('photoInput').dispatchEvent(new w.Event('change')); return file;
  };
  return { dom, w, el, select, requests, revoked };
}

test('single-image chooser, preview and cancel preserve text', () => {
  const { dom, el, select, requests, revoked } = setup();
  try {
    assert.equal(el('photoInput').multiple, false);
    let opened = false; el('photoInput').addEventListener('click', () => { opened = true; });
    el('photoChoose').click(); assert.ok(opened);
    el('messageInput').value = 'unfinished text'; select();
    assert.equal(requests.length, 0); assert.equal(el('photoDraft').classList.contains('hidden'), false);
    assert.equal(el('photoDraftPreview').src, 'blob:test-photo'); el('photoCancel').click();
    assert.equal(el('photoDraft').classList.contains('hidden'), true);
    assert.equal(el('messageInput').value, 'unfinished text'); assert.deepEqual(revoked, ['blob:test-photo']);
  } finally { dom.window.close(); }
});

test('formats, uppercase extension and missing mobile MIME; reject size and HEIC', () => {
  const { dom, el, select, requests, w } = setup();
  try {
    for (const args of [['photo.JPG', 'image/jpeg'], ['photo.png', 'image/png'], ['photo.webp', '']]) {
      select(...args); assert.equal(el('photoDraft').classList.contains('hidden'), false);
    }
    for (const args of [['photo.heic', 'image/heic', 100], ['photo.png', 'image/png', 0], ['photo.png', 'image/png', 6 * 1024 * 1024]]) {
      select(...args); el('photoSend').click(); assert.equal(requests.length, 0);
      assert.equal(el('photoDraft').classList.contains('hidden'), true); assert.ok(el('photoStatus').textContent);
    }
    select(); el('photoDraftPreview').dispatchEvent(new w.Event('error'));
    assert.equal(el('photoDraft').classList.contains('hidden'), true);
  } finally { dom.window.close(); }
});

test('upload progress, duplicate clicks, failure retry and success cleanup', () => {
  const { dom, w, el, select, requests } = setup();
  try {
    const file = select(); const received = [];
    w.document.addEventListener('photo-uploaded', event => received.push(event.detail));
    el('photoSend').click(); el('photoSend').click(); assert.equal(requests.length, 1);
    const req = requests[0]; assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/photos');
    assert.equal(req.headers['Content-Type'], 'image/png'); assert.equal(req.body, file);
    assert.equal(el('photoChoose').disabled, true);
    req.upload.dispatchEvent(new w.ProgressEvent('progress', { lengthComputable: true, loaded: 50, total: 100 }));
    assert.match(el('photoStatus').textContent, /50%/);
    req.respond(413, '请选择小于 6MB 的图片'); assert.match(el('photoStatus').textContent, /6MB/);
    assert.equal(el('photoSend').disabled, false); assert.equal(el('photoDraft').classList.contains('hidden'), false);
    el('photoSend').click(); requests[1].respond(201, message);
    assert.equal(received.length, 1); assert.equal(received[0].id, 123);
    assert.equal(el('photoDraft').classList.contains('hidden'), true); assert.equal(el('photoChoose').disabled, false);
  } finally { dom.window.close(); }
});

test('thumbnail opens original dialog with download and close', () => {
  const { dom, w, el } = setup();
  try {
    const button = w.chatPhotos.createThumbnail(message.image); w.document.body.appendChild(button);
    assert.equal(button.querySelector('img').getAttribute('src'), message.image.thumbnail); button.click();
    assert.equal(el('photoViewer').open, true); assert.equal(el('photoFullImage').getAttribute('src'), message.image.url);
    assert.equal(el('photoDownload').getAttribute('href'), message.image.download);
    assert.equal(el('photoDownload').download, message.image.filename); el('photoViewerClose').click();
    assert.equal(el('photoViewer').open, false); assert.equal(el('photoFullImage').hasAttribute('src'), false);
    assert.equal(w.document.activeElement, button);
  } finally { dom.window.close(); }
});

test('HTTP upload response and WebSocket echo render one photo', async () => {
  const { dom, w, el } = setup();
  try {
    await new Promise(resolve => setImmediate(resolve));
    let socket;
    w.WebSocket = class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } };
    w.fluentEmojiReady = Promise.resolve();
    w.eval(w.document.querySelector('script[data-name="chat-logic"]').textContent);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    w.document.dispatchEvent(new w.CustomEvent('photo-uploaded', { detail: message }));
    socket.onmessage({ data: JSON.stringify(message) }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(el('messageList').querySelectorAll('.chat-photo').length, 1);
  } finally { dom.window.close(); }
});
