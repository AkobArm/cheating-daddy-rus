// Run: node scripts/test-openai-oauth.js
const assert = require('assert');
const crypto = require('crypto');

// Stub electron + storage so the module loads outside Electron.
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { shell: { openExternal: async () => {} }, safeStorage: { isEncryptionAvailable: () => false } };
    return origLoad.apply(this, arguments);
};

const oauth = require('../src/utils/openaiOAuth');

function makeJwt(payloadObj) {
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${b64({ alg: 'none' })}.${b64(payloadObj)}.sig`;
}

// 1. buildAuthUrl carries the codex params + client id + scope
const url = oauth.buildAuthUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 'st', codeChallenge: 'cc' });
assert.ok(url.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann'), 'client_id present');
assert.ok(url.includes('code_challenge_method=S256'), 'S256');
assert.ok(url.includes('id_token_add_organizations=true'), 'org param');
assert.ok(url.includes('codex_cli_simplified_flow=true'), 'simplified flow');
assert.ok(url.includes('originator=codex_cli_rs'), 'originator');
assert.ok(url.includes('api.connectors.read'), 'scope present');

// 1b. redirect URI must use localhost (NOT 127.0.0.1) — Hydra allow-list match
assert.strictEqual(oauth.getRedirectUri(), 'http://localhost:1455/auth/callback', 'redirect uri uses localhost');

// 2. resolveAccountId reads the chatgpt claim
const idToken = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' }, email: 'a@b.c' });
assert.strictEqual(oauth.resolveAccountId(idToken), 'acct_123', 'account id from claim');
assert.strictEqual(oauth.resolveAccountId('garbage'), '', 'no account id -> empty');

// 3. normalizeTokenResponse maps fields + expiry
const norm = oauth.normalizeTokenResponse({ access_token: 'AT', refresh_token: 'RT', id_token: idToken, expires_in: 3600 });
assert.strictEqual(norm.accessToken, 'AT');
assert.strictEqual(norm.refreshToken, 'RT');
assert.strictEqual(norm.accountId, 'acct_123');
assert.strictEqual(norm.accountEmail, 'a@b.c');
assert.ok(norm.expiresAt > Date.now(), 'expiresAt in future');

console.log('OK: all openaiOAuth pure-function tests passed');
