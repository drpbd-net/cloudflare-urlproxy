# cloudflare-urlproxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iceking2nd/cloudflare-urlproxy)

English | [简体中文](./README_zh.md)

A URL reverse proxy running on Cloudflare Workers. Visit `https://<worker-host>/https://<destination>` and the request is proxied to the destination; links inside text responses are rewritten automatically so subsequent requests keep going through the proxy.

## Usage

### Normal mode (text responses are rewritten)

```
https://<worker-host>/https://example.com/page
```

Absolute URLs, absolute paths (`"/path"`), and protocol-relative URLs (`"//host/path"`) in the response are all rewritten to point at the proxy.

### Original passthrough mode

```
https://<worker-host>/~~/https://example.com/page
```

The response body is passed through untouched; everything else (response header handling, authentication) behaves the same.

### FTP destinations

`fetch()` does not support FTP, so the proxy ships a minimal FTP client built on `cloudflare:sockets` (passive mode, EPSV first / PASV fallback):

```
https://<worker-host>/ftp://ftp.example.com/pub/file.txt    file: streamed binary, content-type by extension
https://<worker-host>/ftp://ftp.example.com/pub/            directory: HTML navigation page, links stay proxied
```

URL-embedded credentials are supported (`ftp://user:pass@host/`; the password is percent-decoded before login); without credentials it logs in as anonymous. Directory page links keep the existing credentials so browsing continues seamlessly. A directory path without a trailing slash is first tried as a file (RETR) and falls back to a directory listing when it does not exist. Protocols other than HTTP(S)/FTP (e.g. `ssh://`) still return 400.

### Authentication

Every proxied request needs an access token, via either:

```sh
# request header (for programmatic use)
curl -H "X-Proxy-Token: <token>" "https://<worker-host>/https://example.com/page"

# query parameter (handy for the browser address bar; stripped before forwarding to the destination)
https://<worker-host>/https://example.com/page?__proxy_token=<token>
```

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `PROXY_TOKEN` | Yes | Access token; multiple comma-separated tokens are supported (any one matching passes; a token itself cannot contain a comma). **Set as a secret only** (`npx wrangler secret put PROXY_TOKEN`); never put it in vars (a same-name var overwrites the remote secret on every deploy). Until it is set the proxy is fail-closed and rejects everything (503) |
| `ALLOWED_ORIGINS` | No | Extra origins allowed to read proxied responses cross-origin, comma-separated, e.g. `https://app.example.com` |

### Local development

Create `.dev.vars` in the project root (already gitignored, do not commit it):

```
# multiple tokens, comma-separated
PROXY_TOKEN=dev-token,dev-token-2
```

Then:

```sh
npm install
npm run dev
```

## Deploying

`wrangler.jsonc` always stays an **example** in the repository (observability off, placeholder custom domains). Production deployments use a throwaway config and never modify the repo copy.

### Option 1: one-click from the Cloudflare dashboard

Click the **Deploy to Cloudflare** button at the top of this README and follow the wizard to connect the repository to your Cloudflare account and deploy. Afterwards set the `PROXY_TOKEN` secret in the dashboard under Settings → Variables (until then every request is rejected).

### Option 2: manual deploy with a throwaway config

```sh
cp wrangler.jsonc wrangler.prod.jsonc       # wrangler.prod.jsonc is gitignored
# edit wrangler.prod.jsonc: name, routes (your custom domains), enable observability as needed
npx wrangler deploy --config wrangler.prod.jsonc
npx wrangler secret put PROXY_TOKEN --config wrangler.prod.jsonc   # fail-closed: all requests rejected until set
rm wrangler.prod.jsonc
```

The example config ships with production best practices pre-set: **the workers.dev route and preview URLs are both disabled** (`workers_dev: false` + `preview_urls: false`), exposing the proxy through custom domains only.

## Security design

- **Fail-closed authentication**: every proxy request is rejected until `PROXY_TOKEN` is set; multiple comma-separated tokens are supported (empty segments are filtered, an all-empty value counts as unconfigured); tokens are compared in constant time, iterating all of them without early exit so timing never reveals which one matched
- **Credential isolation**: proxy-domain `Cookie` and the access token are never forwarded; the destination's `Set-Cookie` is dropped (proxied targets never share the proxy-domain cookie jar); `Authorization` is an explicit client credential and is forwarded
- **CSP**: a restrictive CSP is always applied — proxied pages can only load resources from, and send requests to, the proxy itself
- **CORS**: only the proxy's own origin or the `ALLOWED_ORIGINS` allowlist; client-controlled headers are never reflected
- **Input validation**: destinations must be absolute `http(s)://` or `ftp://` URLs; loops pointing back at the proxy are rejected (400); FTP command arguments are stripped of CR/LF against injection
- **Log redaction**: non-200 statuses log the status and URL only; URL credentials become `user:***@`; credential-like headers in trace logs are `[REDACTED]`

## Known limitations

- URL rewriting is regex-based and rewrites every `http(s)://` and quoted absolute path in text — including JSON/JS string values (e.g. `url` fields in API payloads) — which can break downstream parsers; use `/~~/` mode when you need the original content
- Because `Set-Cookie` is stripped, destinations relying on cookie sessions cannot stay logged in (a deliberate security trade-off)
- The CSP's `script-src` includes `'unsafe-inline'` to keep inline-script sites working
- FTP support is **plaintext FTP only** (no FTPS); login passwords cross the wire in the clear, so stick to anonymous or non-sensitive resources; FTP credentials are redacted in logs, but directory page links do keep (escaped) credentials already present in the URL — do not share such links
- FTP passive mode ignores the IP returned by PASV (always reconnects to the control-connection host, sidestepping NAT); each FTP request holds 2 concurrent TCP connections (control + data), bounded by the Workers simultaneous-open-connection limit; Workers cannot connect to Cloudflare's own IP ranges

## Development

```sh
npm run dev     # local dev server
npm test        # vitest (34 cases: HTTP proxy behavior + FTP protocol sessions, replayed via FakeSocket, fully offline)
npx tsc --noEmit -p tsconfig.json       # typecheck main code
npx tsc --noEmit -p test/tsconfig.json  # typecheck tests
```

Run `npm run cf-typegen` to regenerate types after changing bindings in `wrangler.jsonc`.

## License

[MIT](./LICENSE)
