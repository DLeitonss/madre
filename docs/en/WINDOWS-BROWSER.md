# Windows Edge and Chrome from MADRE in WSL

Status: implementation validated with real Edge and Chrome on 2026-11-01. Conditional verdict: Windows Node `>=20` is required; the human reported updating the tested machine and obtaining Node `v26.13.0`, which was not rechecked in this review. The active installation and Windows/WSL network have not been changed. Español: [guía Windows](../WINDOWS-BROWSER.md).

## Explicit Windows setup

Requires Windows Node.js `>=20` on PATH, WSL interop and Windows access to the distribution's paths (`wslpath -w`). MCP runs in Windows and communicates with MADRE over stdio. CDP stays on Windows loopback; WSL does not need TCP access to its port. No NAT, firewall or `networkingMode` changes are made.

The human runs these commands in **Windows PowerShell**. Installation downloads packages from the npm registry; it was run explicitly during the 2026-11-01 validation, but the module never automates it:

```powershell
node.exe -e "const major=Number(process.versions.node.split('.')[0]); if(major<20){throw new Error('MADRE Windows browser requires Node >=20')} console.log(process.version)"
npm.cmd install --prefix "$env:LOCALAPPDATA\MADRE\browser-server" --save-exact @playwright/mcp@0.0.83
```

Exactly `0.0.83` is required. Runtime does not download, update or fall back to a global package. `updatePlan` gives Windows setup instructions instead of installing Linux packages. The package, dependencies and lockfile remain in this Windows directory.

Open **Edge** with a dedicated profile that is not already running:

```powershell
$profileDir = "$env:LOCALAPPDATA\MADRE\browser\msedge"
Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',"--user-data-dir=`"$profileDir`"",'about:blank'
```

For **Chrome**, use a different profile and port:

```powershell
$profileDir = "$env:LOCALAPPDATA\MADRE\browser\chrome"
Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223',"--user-data-dir=`"$profileDir`"",'about:blank'
```

Use your actual executable path if different. Do not use your ordinary personal profile. Before signing in, verify that the dedicated profile has no synchronization or extensions; remove any wallet, password manager or other sensitive extension from that profile. Close only a previous dedicated-profile window when changing its arguments. No locks are deleted and no other browsers are stopped. Verify that the listening process belongs to the dedicated profile and that its port was free.

In TEST BROWSER, choose `CONNECTION = windows`, `BROWSER = msedge` or `chrome`, and leave `WINDOWS CDP` empty: Edge defaults to `9222`, Chrome to `9223`. A custom endpoint must be `http://127.0.0.1:<port>`. Then enable the module. `WEBSITES` retains `local`, `youtube` and `all`. Initial defaults remain `CONNECTION = local`, `WEBSITES = local`, `SESSION = isolated`.

## Session, permissions and shutdown

The human manages the Windows window. `SESSION` and `SHOW THE WINDOW` only control local connections. Every agent and project using the same endpoint shares its tabs, cookies and account. There is no project isolation or concurrency queue: use one agent at a time and open a new tab for each task before navigating. Sign in personally and tell the agent when finished; Google sign-in acceptance is not guaranteed.

The health probe only reads `/json/version`. It never initializes MCP, navigates, creates, selects or closes a tab. It checks the browser product and a loopback WebSocket on the same port. It does not verify the profile directory; check `edge://version` or `chrome://version` yourself.

The server receives literal arguments without a shell. `wslpath` converts the scratch and workspace directories, including UNC paths. The bridge removes the Linux client's MCP `roots` capability so the server uses its converted Windows project cwd as its workspace. Additional client roots are not shared. Inherited `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS` and `NODE_PATH` variables are removed before starting the Windows process and MCP server.

Screenshots **without an explicit filename** land in the same turn folder accessible from WSL. Explicit filenames resolve against the project root in the pinned server; omit the filename to keep screenshots in the turn folder. Tool responses may display Windows paths; convert them back with `wslpath -u '<Windows path>'`. Unrestricted file access is not enabled.

On disconnect, the worker closes the MCP server's stdin, then terminates only its own Node process if needed. Heartbeats also allow it to detect a vanished WSL relay. It never uses `taskkill /T` or kills the external browser. The real test confirmed browser and tab persistence with both products. A machine or WSL shutdown may interrupt cleanup.

CDP grants control of the entire profile to local processes accessing its port. Playwright's `--allowed-origins` filtering is not a security boundary: it does not cover all redirects, browser-internal pages, pre-existing tabs or all console output from other tabs. `local` reduces direct navigation but does not contain a hostile agent. `all` allows traffic to any requested website and its sign-in providers. The human's task and permission limits still apply. Do not use this connection to isolate a sensitive account; never commit browser profiles.

## Diagnostics and validation

From PowerShell, without navigating tabs:

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
Invoke-RestMethod http://127.0.0.1:9223/json/version
Get-NetTCPConnection -LocalPort 9222,9223 -State Listen
```

Listeners must be loopback only, never `0.0.0.0`, `::` or a LAN interface. Otherwise close that dedicated browser before enabling the module. Corporate policies may disable CDP.

From this project in WSL, using `pulse-run` or execution permission:

```bash
node --check madre/src/modules/playwright.mjs
node --check madre/src/modules/playwright-windows.mjs
node --test tests/browser.test.mjs tests/browser.domains.test.mjs tests/browser.windows.test.mjs tests/browser.delivery.test.mjs
node madre/src/modules/playwright-windows.mjs probe '{"browser":"msedge"}'
node madre/src/modules/playwright-windows.mjs probe '{"browser":"chrome"}'
node tests/browser.windows.real.mjs
```

Real probes require the setup above and are separate from unit tests. Metadata probes do not prove MCP tool calls work.

Real result on 2026-11-01: Edge `156.0.4314.50`, Chrome `156.0.8078.74` and `@playwright/mcp@0.0.83` passed handshake/tool discovery, navigation to a WSL fixture, blocking under `local`, access under `all`, a PNG screenshot readable from WSL, tab/cookie persistence across connections, relay shutdown without closing the browser, and a subsequent successful probe. The test exited 0 and both screenshots were inspected visually.

Post-adapter-fix validation: the Windows connection gives the relay only `WSL_DISTRO_NAME` and `WSL_INTEROP`, and Codex configures that MCP with `required=true`. With Chrome open on its dedicated profile, real Claude and Codex turns reached the local fixture and both opened a new tab: 2/2, without the Codex control fallback. Edge was not repeated: the open process did not expose CDP and the profile previously observed contained an account and sensitive extensions, so it was left untouched until the human cleans it. The active MADRE installation still has not received the patch.

The apparent `browser.login` intermittency was a faulty measurement: on reopen Chromium could serve the document from cache, while the test discarded heartbeat headers and checked the cookie before the next heartbeat. The test now observes every request and waits for the cookie; it passed 6/6 in isolation and once in the complete local suite. That suite finished with 112 passed, 3 known limits marked `TODO`, and 0 failures. `npm test` and `npm run pack:check` still cannot run in this partial copy because `madre/test/setup.mjs` and `madre/scripts/pack-check.mjs` are absent.

The run also found that Windows Node `18.17.0` could probe CDP but failed on the first MCP RPC because the installed dependencies require Node `>=20`. The bridge now checks the version before starting the server and reports the incompatible version. The human later reported that global Node returned `v26.13.0`; this review did not repeat that measurement. `tests/browser.windows.real.mjs` assumes a suitable Node is already on the Windows PATH and leaves dedicated-profile test tabs open to prove persistence.

Restart/use from the active installation, checking the profile visually in `edge://version`/`chrome://version`, and real sign-in remain human steps. Resolve Windows-to-WSL localhost access separately if it fails; this bridge does not change networking.

Sources: [Playwright MCP options and limitations](https://github.com/microsoft/playwright-mcp/tree/v0.0.83), [pinned package metadata](https://github.com/microsoft/playwright-mcp/blob/v0.0.83/package.json), [Edge diagnostic endpoint](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/#jsonversion).
