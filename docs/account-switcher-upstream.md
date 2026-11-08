# Account Switcher upstream updates

The launcher's Windows Account Switcher interoperates with Lampese's
`~/.codex-switcher/accounts.json` store. It adapts session behavior from
[Lampese/codex-switcher](https://github.com/Lampese/codex-switcher), reviewed at
`dede43e209687b6761f1e6d86a9452d041d6ee8d` on November 8, 2026.
The upstream MIT notice is bundled as `launcher/electron/CODEX_SWITCHER_LICENSE.txt`.

Version 6.1.19 integrates these behaviors:

- Preserve rotated live credentials before switching away.
- Refresh an expired ID token even if the access token has not expired.
- Serialize usage refresh, token rotation, account additions, removals and switches.
- Never rotate the active account's refresh token while the official app runs.
- Share one refresh attempt across concurrent unauthorized usage/profile requests;
  do not rotate credentials on HTTP 403.
- Save rotated replacement tokens even if the server omits a usable ID token,
  while refusing to activate the incomplete session.
- Keep a newly imported first account inactive until explicitly switched to.
- Accept canonical `chat_g_p_t` and legacy `chat_g_pt`, `chat_gpt`, `chatgpt` auth modes.
- Bound OAuth requests through response body consumption, with safe errors and no
  automatic retry of an uncertain single-use token request.

The launcher already had bounded authorization-code exchange, reset credit
summaries, profile usage stats and selective cache deletion. Those remain in place.
Standalone switcher tray, warm-up scheduling and encrypted export interfaces are
outside this embedded account session update.

Tests use isolated account stores, mocked services and simulated app processes.
They do not switch the signed-in production account or prove a live OAuth login.
