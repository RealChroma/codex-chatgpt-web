const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function tokenExpiry(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function needsRefresh(data, now = Date.now()) {
  if (!data || data.mode !== "chatgpt") return false;
  const deadline = now / 1000 + 60;
  const idExpiry = tokenExpiry(data.idToken);
  const accessExpiry = tokenExpiry(data.accessToken);
  return idExpiry === null || idExpiry <= deadline || (accessExpiry !== null && accessExpiry <= deadline);
}

async function refreshOAuthToken(refreshToken, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!refreshToken) throw new Error("Missing refresh token; sign in to this account again");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A refresh token may be single-use. An uncertain response must never be retried here.
    const response = await fetchImpl(`${ISSUER}/oauth/token`, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
    });
    if (!response.ok) throw new Error(`OAuth refresh failed (HTTP ${response.status}); sign in to this account again`);
    const value = await response.json();
    if (typeof value?.access_token !== "string" || !value.access_token.trim()) {
      throw new Error("OAuth refresh response was incomplete; sign in to this account again");
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OAuth refresh timed out; retry by signing in again");
    if (/^OAuth refresh/.test(error?.message)) throw error;
    throw new Error("OAuth refresh failed; sign in to this account again");
  } finally { clearTimeout(timer); }
}

module.exports = { needsRefresh, refreshOAuthToken, tokenExpiry };
