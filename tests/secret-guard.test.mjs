import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { scanText, checkCompose } from '../scripts/secret-guard.mjs';

const generated = () => randomBytes(24).toString('hex');
test('guard rejects runtime-built literal credentials without disclosing their values', () => {
  const value = generated();
  for (const content of [
    ['POSTGRES_PASSWORD', ': ', value].join(''),
    ['password', ' = "', value, '"'].join(''),
    ['api_key', ': "', value, '"'].join(''),
    ['"client_secret"', ': ', value].join(''),
    ['POSTGRES_PASSWORD', ': ${DAW_DB_PASSWORD:-', value, '}'].join(''),
    ['postgresql://fixture:', value, '@localhost/db'].join(''),
    ['Authorization: ', 'Basic', ' ', Buffer.from(value).toString('base64')].join(''),
    ['Authorization: ', 'Bearer', ' ', value].join(''),
    ['ghp', '_', value].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  ]) {
    const findings = scanText('fixture.txt', content);
    assert.ok(findings.length > 0, 'unsafe fixture must fail');
    assert.ok(!JSON.stringify(findings).includes(value), 'findings must not include credential material');
  }
});
test('guard preserves required configuration, generated expressions and passwordless local test URLs', () => {
  for (const content of [
    'POSTGRES_PASSWORD: ${DAW_DB_PASSWORD:?Provide externally}',
    'postgresql://daw:${DAW_DB_PASSWORD}@127.0.0.1:15432/daw',
    'postgresql://daw_test@127.0.0.1:12345/test',
    'const token = randomBytes(32).toString("hex");',
  ]) assert.deepEqual(scanText('fixture.txt', content), []);
});
test('guard detects tracked dotenv even when empty', () => {
  for (const file of ['.env', '.env.testing', 'nested/.env.local']) assert.equal(scanText(file, '').length, 1);
});
test('Compose contract fails if the required value, empty-value protection or loopback boundary is removed', () => {
  const safe = 'POSTGRES_PASSWORD: ${DAW_DB_PASSWORD:?Provide externally}\nports: ["127.0.0.1:15432:5432"]';
  assert.equal(checkCompose(safe), true);
  for (const unsafe of [safe.replace(':?', '?'), safe.replace(':?', ':-'), safe.replace(':?', ''), safe.replace('127.0.0.1:', ''), safe + '\n' + safe,
    safe.replace('127.0.0.1:', '0.0.0.0:') + '\n# prior mapping 127.0.0.1:15432:5432',
    safe.replace('15432:5432"]', '15432:5432", "0.0.0.0:15433:5432"]'),
  ]) assert.equal(checkCompose(unsafe), false);
});
