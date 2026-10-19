# Native web hosting

`opencode serve` hosts the built web app and API together. Supply the instance's
`OPENCODE_PASSWORD` through the process environment, then bind the private listener:

```sh
opencode serve --hostname 127.0.0.1 --port 4096 --base-path /computer/c/example/
```

`OPENCODE_BASE_PATH` supplies the same setting when the flag is omitted, including
for a managed service. The default is `/`. The path is external metadata: an HTTP
gateway must remove it before forwarding requests to OpenCode. Native API routes
remain `/api/...`; no second API or authentication protocol is introduced.

The built asset archive is reusable across mount paths. The web host sets the HTML
base, and the browser uses it for navigation, its default API address, worker scope,
and PWA routes. The host updates the HTML's exact precache integrity in the service
worker after changing the base; other asset bytes and integrity remain unchanged.
Pairing redirects and browser cookies use the same mount. For an external pairing
link, use `opencode pair --url https://example.com/computer/c/example/`.

Serve a canonical trailing slash at the mount entry. Forward WebSocket upgrades
and unbuffered SSE as well as ordinary HTTP, retaining the public host for native
same-origin cookie checks. Authenticate and authorize the selected private instance
at the gateway; this setting does not provide OIDC or multi-user admission.

MCP OAuth remains native. For a remote browser, configure the remote server's
`oauth.redirect_uri` and fixed `oauth.callback_port`, and forward that callback to
the instance's private loopback listener with its configured pathname unchanged.
The normal web-prefix stripping route alone does not expose that separate listener.

For an authenticated local proxy inside a private sandbox, explicitly delegate
admission instead of configuring an OpenCode password:

```sh
opencode serve --trusted-local-proxy --hostname 127.0.0.1 --port 4096 --base-path /computer/c/example/
```

This mode accepts only literal `127.0.0.1` or `::1` and foreground serving. It
rejects `--service`, `--stdio`, and either password environment variable, including
an empty configured value. It does not register a managed service, publish local
or remote connection URLs, or issue pairing links/cookies. The native API has no
inner password in this mode: the proxy must authenticate the user, authorize the
selected sandbox, reject cross-origin mutations/upgrades and strip inbound browser
credentials before forwarding. Keep the listener inside the private sandbox
loopback namespace and reach it through authenticated native forwarding. Ordinary
`serve` continues to generate or require its native password.

Trusted local proxy mode also serves the UI online-only: responses use
`private, no-store`, the shell does not register a service worker, and worker
scripts are unavailable. The outer gateway must preserve these cache restrictions
so a later visit reaches current browser admission. Normal serving retains PWA
offline support.

Browser UI caches are scoped by the validated external mount, including recent
projects/tabs, saved server entries, draft IndexedDB, cross-tab messages,
notifications and preferences. Nonroot mounts start with their own storage and do
not import root history. Root and native desktop stores retain their existing
keys. Use a stable distinct mount per private instance when accounts can change
in one browser profile; this separates UI state within the same origin, while the
gateway remains responsible for authorization.
