import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWireOutput } from '../apps/chrome-extension/sidepanel/wire-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '../apps/chrome-extension');

test('Chrome Extension MV3 manifest references valid files and sidePanel configuration', () => {
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('tabCapture'));
  assert.ok(manifest.permissions.includes('offscreen'));

  // Rule: never define default_popup when using setPanelBehavior({ openPanelOnActionClick: true })
  assert.equal(manifest.action?.default_popup, undefined);

  assert.ok(fs.existsSync(path.join(EXT_DIR, manifest.side_panel.default_path)));
  assert.ok(fs.existsSync(path.join(EXT_DIR, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(EXT_DIR, 'offscreen/offscreen.html')));
  assert.ok(fs.existsSync(path.join(EXT_DIR, 'offscreen/offscreen.js')));

  for (const cs of manifest.content_scripts || []) {
    for (const jsFile of cs.js || []) {
      assert.ok(
        fs.existsSync(path.join(EXT_DIR, jsFile)),
        `Missing content script: ${jsFile}`
      );
    }
  }

  assert.ok(manifest.commands['open-side-panel']);
  assert.ok(manifest.commands['copy-reply-1']);
  assert.ok(manifest.commands['copy-reply-2']);
  assert.ok(manifest.commands['copy-reply-3']);
});

test('SidePanel wire-parser parses compact T|Q|R1|R2|R3 output and strips reasoning blocks', () => {
  const parsed = parseWireOutput(
    '<think>reasoning</think>\nT|Kapan target rilisnya?\nQ|1\nR1|Next Tuesday.\nR2|We plan to deploy next Tuesday after QA.\nR3|Could you clarify which service?'
  );
  assert.equal(parsed.t, 'Kapan target rilisnya?');
  assert.equal(parsed.q, true);
  assert.equal(parsed.r1, 'Next Tuesday.');
  assert.equal(parsed.r2, 'We plan to deploy next Tuesday after QA.');
  assert.equal(parsed.r3, 'Could you clarify which service?');
});
