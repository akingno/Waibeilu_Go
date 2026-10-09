import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

const databaseSource = await readFile(new URL('../public/vendor/emoji-picker-element/database.js', import.meta.url), 'utf8');
const pickerSource = await readFile(new URL('../public/vendor/emoji-picker-element/picker.js', import.meta.url), 'utf8');

function loadChecksum(crypto) {
  const start = databaseSource.indexOf('function arrayBufferToBinaryString');
  const end = databaseSource.indexOf('async function doCheckForUpdates');
  return vm.runInNewContext(`${databaseSource.slice(start, end)}; jsonChecksum`, { crypto, btoa });
}

test('emoji cache checksum works without Web Crypto on HTTP', async () => {
  for (const crypto of [undefined, {}]) {
    const checksum = loadChecksum(crypto);
    const data = [{ emoji: '😀', annotation: '笑脸' }];
    assert.equal(await checksum(data), await checksum(structuredClone(data)));
    assert.notEqual(await checksum(data), await checksum([{ emoji: '😁', annotation: '笑脸' }]));
  }
});

test('HTTPS keeps the existing SHA-1 cache checksum', async () => {
  const data = [{ emoji: '😀' }];
  // Match the vendored library's UTF-16-code-unit to byte conversion.
  const input = JSON.stringify(data);
  const originalBytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) originalBytes[i] = input.charCodeAt(i);
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-1', originalBytes)).toString('base64');
  assert.equal(await loadChecksum(webcrypto)(data), expected);
});

for (const storage of ['pending', 'rejected']) {
  for (const custom of [false, true]) {
    test(`${custom ? 'custom' : 'native'} emoji selection survives ${storage} favorites write`, async () => {
      const summary = custom ? { id: 'heart', name: 'heart' } : { id: '👍', unicode: '👍' };
      const state = {
        currentEmojis: [summary], currentFavorites: [], currentSkinTone: 1,
        database: {
          getEmojiByUnicodeOrName: async () => summary,
          incrementFavoriteEmojiCount: () => storage === 'pending'
            ? new Promise(() => {}) : Promise.reject(new Error('storage unavailable')),
        },
      };
      const start = pickerSource.indexOf('  async function getDetailForClickEvent');
      const end = pickerSource.indexOf('  async function clickEmoji', start);
      const select = vm.runInNewContext(`${pickerSource.slice(start, end)}; getDetailForClickEvent`, {
        state, unicodeWithSkin: () => '👍🏻', console: { warn() {} },
      });
      let timeout;
      try {
        const detail = await Promise.race([
          select(summary.id),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('selection blocked')), 500); }),
        ]);
        assert.equal(custom ? detail.name : detail.unicode, custom ? 'heart' : '👍🏻');
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
