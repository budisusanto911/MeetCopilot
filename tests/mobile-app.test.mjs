import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.resolve(__dirname, '../apps/mobile-app');

test('Android mobile-app project structure, manifest permissions, and Kotlin sources exist', () => {
  const gradleApp = fs.readFileSync(path.join(MOBILE_DIR, 'app/build.gradle.kts'), 'utf8');
  assert.match(gradleApp, /compileSdk = 35/);
  assert.match(gradleApp, /minSdk = 26/);
  assert.match(gradleApp, /com\.squareup\.okhttp3:okhttp/);

  const manifest = fs.readFileSync(
    path.join(MOBILE_DIR, 'app/src/main/AndroidManifest.xml'),
    'utf8'
  );
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.SYSTEM_ALERT_WINDOW/);
  assert.match(manifest, /OverlayCopilotService/);

  const kotlinFiles = [
    'TokenFrugalEngine.kt',
    'WaterfallNetworkClient.kt',
    'LocalContextVault.kt',
    'CopilotStateBus.kt',
    'OverlayCopilotService.kt',
    'MainActivity.kt'
  ];
  for (const file of kotlinFiles) {
    assert.ok(
      fs.existsSync(path.join(MOBILE_DIR, 'app/src/main/java/com/meetcopilot/app', file)),
      `Missing Kotlin source: ${file}`
    );
  }

  assert.ok(
    fs.existsSync(
      path.join(MOBILE_DIR, 'app/src/test/java/com/meetcopilot/app/TokenFrugalEngineTest.kt')
    )
  );
});
