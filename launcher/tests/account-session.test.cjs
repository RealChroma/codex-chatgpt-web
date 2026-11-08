const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountSwitcher, projectAccount } = require("../electron/account-switcher.cjs");
const { refreshOAuthToken, needsRefresh } = require("../electron/account-oauth.cjs");

function jwt(id, exp = 4_000_000_000) {
  return `header.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
}
function entry(id, exp) {
  return { id, name: id, auth_mode: "chat_g_p_t", auth_data: {
    type: "chat_g_p_t", account_id: id, id_token: jwt(id, exp), access_token: `access-${id}`, refresh_token: `refresh-${id}`,
  } };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-session-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, "accounts.json");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  const authPath = path.join(codexHome, "auth.json");
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const read = file => JSON.parse(fs.readFileSync(file));
  write(storePath, { version: 1, active_account_id: "a", accounts: [entry("a"), entry("b")] });
  write(authPath, { tokens: entry("a").auth_data });
  const switcher = createAccountSwitcher({ platform: "win32", codexHome, accountStorePath: storePath,
    usageCachePath: path.join(root, "usage.json"), activityPath: path.join(root, "activity.json"),
    resolveIdentity: async () => ({}), listProcesses: async () => [], ...options });
  return { switcher, storePath, authPath, read, write };
}

test("all upstream legacy ChatGPT spellings remain usable", () => {
  for (const spelling of ["chat_g_p_t", "chat_g_pt", "chat_gpt", "chatgpt"]) {
    const account = entry("a"); account.auth_mode = spelling; account.auth_data.type = spelling;
    assert.equal(projectAccount(account, null).authMode, "chatgpt");
  }
});

test("first imported account stays inactive and does not create live auth", async t => {
  const f = fixture(t);
  f.write(f.storePath, { version: 1, active_account_id: null, accounts: [] });
  const source = f.authPath + ".import";
  f.write(source, { tokens: entry("b").auth_data });
  fs.unlinkSync(f.authPath);
  const snapshot = await f.switcher.addAccountFromFile(source);
  assert.equal(snapshot.activeAccountId, null);
  assert.equal(snapshot.accounts[0].isActive, false);
  assert.equal(snapshot.accounts[0].lastUsedAt, null);
  assert.equal(f.read(f.storePath).active_account_id, null);
  assert.equal(fs.existsSync(f.authPath), false);
  await f.switcher.switchAccount(snapshot.accounts[0].id);
  assert.equal(f.read(f.authPath).tokens.account_id, "b");
});

test("switch refreshes expired ID tokens and preserves live outgoing rotation", async t => {
  let refreshes = 0;
  const f = fixture(t, { refreshTokens: async token => {
    refreshes++; assert.equal(token, "refresh-b");
    return { id_token: jwt("b"), access_token: "access-new", refresh_token: "refresh-new" };
  } });
  const store = f.read(f.storePath); store.accounts[1] = entry("b", 1); f.write(f.storePath, store);
  const live = f.read(f.authPath); live.tokens.refresh_token = "refresh-a-live"; f.write(f.authPath, live);
  await f.switcher.switchAccount("b");
  assert.equal(refreshes, 1);
  assert.equal(f.read(f.authPath).tokens.refresh_token, "refresh-new");
  assert.equal(f.read(f.storePath).accounts[1].auth_data.refresh_token, "refresh-new");
  assert.equal(f.read(f.storePath).accounts[0].auth_data.refresh_token, "refresh-a-live");
});

test("rotated refresh token survives missing fresh ID token without switching", async t => {
  let stopped = false;
  const f = fixture(t, { refreshTokens: async () => ({ access_token: "access-new", refresh_token: "refresh-new" }),
    listProcesses: async () => [{ ProcessId: 1 }], terminateProcesses: async () => { stopped = true; } });
  const store = f.read(f.storePath); store.accounts[1] = entry("b", 1); f.write(f.storePath, store);
  const before = fs.readFileSync(f.authPath, "utf8");
  await assert.rejects(f.switcher.switchAccount("b"), /fresh ID token/);
  assert.equal(f.read(f.storePath).accounts[1].auth_data.refresh_token, "refresh-new");
  assert.equal(fs.readFileSync(f.authPath, "utf8"), before);
  assert.equal(stopped, false);
});

test("account identity mismatch never activates the returned session", async t => {
  const f = fixture(t, { refreshTokens: async () => ({ id_token: jwt("foreign"), access_token: "new", refresh_token: "new" }) });
  const store = f.read(f.storePath); store.accounts[1] = entry("b", 1); f.write(f.storePath, store);
  const before = fs.readFileSync(f.authPath, "utf8");
  await assert.rejects(f.switcher.switchAccount("b"), /different account/);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), before);
});

test("usage refresh serializes with switches and skips active app token rotation", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { refreshTokens: async token => {
    assert.equal(token, "refresh-b"); await held;
    return { id_token: jwt("b"), access_token: "new", refresh_token: "rotated" };
  }, listProcesses: async () => [{ ProcessId: 1 }], terminateProcesses: async () => {},
  beforeOfficialRestart: async () => null, afterOfficialRestart: async () => {} });
  const store = f.read(f.storePath); store.accounts = [entry("a", 1), entry("b", 1)]; f.write(f.storePath, store);
  f.write(f.authPath, { tokens: entry("a", 1).auth_data });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => { globalThis.fetch = originalFetch; release(); });
  const refresh = f.switcher.refreshUsage();
  const switching = f.switcher.switchAccount("b");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.read(f.authPath).tokens.account_id, "a");
  release(); await Promise.all([refresh, switching]);
  assert.equal(f.read(f.authPath).tokens.refresh_token, "rotated");
  assert.equal(f.read(f.storePath).active_account_id, "b");
});

test("refresh HTTP errors never leak bodies or retry single-use tokens", async () => {
  let calls = 0;
  await assert.rejects(refreshOAuthToken("secret", { fetchImpl: async () => {
    calls++; return { ok: false, status: 403, text: async () => "private token payload" };
  } }), error => /HTTP 403/.test(error.message) && !/secret|private/.test(error.message));
  assert.equal(calls, 1);
});

for (const status of [401, 403]) test(`usage HTTP ${status} only refreshes credentials on 401, once across endpoints`, async t => {
  let rotations = 0;
  const f = fixture(t, { refreshTokens: async () => {
    rotations++; return { id_token: jwt("b"), access_token: "fresh", refresh_token: "rotated" };
  } });
  const store = f.read(f.storePath); store.accounts = [entry("b")]; f.write(f.storePath, store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const ok = options.headers.Authorization === "Bearer fresh";
    return { ok, status: ok ? 200 : status, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const before = fs.readFileSync(f.authPath, "utf8");
  await f.switcher.refreshUsage();
  assert.equal(rotations, status === 401 ? 1 : 0);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), before);
});

test("refresh deadline bounds response body consumption", async () => {
  await assert.rejects(refreshOAuthToken("secret", { timeoutMs: 10, fetchImpl: async (_url, options) => ({
    ok: true, json: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  }) }), /timed out/);
});

test("ID expiry is checked independently of access token expiry", () => {
  assert.equal(needsRefresh({ mode: "chatgpt", idToken: jwt("a", 1), accessToken: jwt("a") }), true);
  assert.equal(needsRefresh({ mode: "chatgpt", idToken: jwt("a"), accessToken: jwt("a") }), false);
});
