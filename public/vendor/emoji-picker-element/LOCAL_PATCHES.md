# Local compatibility patches

Preserve or re-evaluate these changes when updating this vendored library:

- `database.js`: use a non-cryptographic cache checksum when Web Crypto is
  unavailable (plain HTTP and no ETag). The HTTPS checksum remains unchanged.
- `picker.js`: do not block emoji selection on the optional favorites write;
  report write failures as warnings.

Regression checks: `node --test tests/emoji.test.mjs` from the project root.
The upstream source maps have not been regenerated for these local patches.
