/**
 * cloudflare-urlproxy: URL 反向代理 Worker
 *
 * 用法:
 *   https://<worker-host>/https://<destination>      文本响应自动改写内部链接
 *   https://<worker-host>/~~/https://<destination>   原样直通, 不改写 body
 *
 * 认证 (fail-closed, PROXY_TOKEN secret 未配置时拒绝所有代理请求):
 *   - 请求头 X-Proxy-Token: <token>
 *   - 查询参数 ?__proxy_token=<token> (该参数会被剥离, 不转发给目标)
 *
 * cloudflare-urlproxy: URL reverse proxy Worker
 *
 * Usage:
 *   https://<worker-host>/https://<destination>      text responses get internal links rewritten
 *   https://<worker-host>/~~/https://<destination>   original passthrough, body untouched
 *
 * Authentication (fail-closed: all proxying is rejected until the PROXY_TOKEN secret is set):
 *   - request header X-Proxy-Token: <token>
 *   - query parameter ?__proxy_token=<token> (stripped, never forwarded to the destination)
 */

import { fetchFtp, redactUrlCredentials } from "./ftp";

const PROXY_TOKEN_HEADER = "x-proxy-token";
const PROXY_TOKEN_QUERY = "__proxy_token";
const ORIGINAL_CONTENT_PREFIX = "/~~/";
const TEXT_CONTENT_MARKERS = ["text", "javascript", "html", "json"];

/** 解析结果: 成功时携带目的 URL, 失败时携带错误响应信息 / Parse result: destination URL on success, error response info on failure */
type ParsedDestination =
	| { dstUrl: URL; dstUrlStr: string; originalContent: boolean }
	| { error: string; status: number };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const func = "src.index.fetch";
		const url = new URL(request.url);
		console.debug("incoming request", { func, method: request.method, url: request.url });

		// favicon 直接空响应, 无需认证 (浏览器自动请求, 带不上 token) / favicon gets an empty response without auth (browsers request it automatically, no token attached)
		if (url.pathname.startsWith("/favicon.ico")) {
			return new Response(null, { status: 204, statusText: "No content" });
		}

		const authError = checkProxyToken(request, env, url);
		if (authError) return authError;

		const parsed = parseDestinationUrl(url);
		if ("error" in parsed) {
			return new Response(parsed.error, { status: parsed.status });
		}
		const { dstUrl, dstUrlStr, originalContent } = parsed;
		// 日志中的目的 URL 一律脱敏凭据 / destination URLs in logs always have credentials redacted
		const loggableDst = redactUrlCredentials(dstUrl);
		console.debug("destination parsed", { func, dstUrlStr: loggableDst, originalContent });

		if (dstUrl.protocol === "ftp:") {
			// fetch() 不支持 FTP, 分派到基于 cloudflare:sockets 的 FTP 客户端 / fetch() does not support FTP; dispatch to the cloudflare:sockets based FTP client
			console.debug("routing to FTP client", { func, dstUrlStr: loggableDst });
			const ftpResponse = await fetchFtp(dstUrl, (p) => ctx.waitUntil(p), `${url.protocol}//${url.host}/`);
			const headers = buildResponseHeaders(request, env, url, ftpResponse);
			return new Response(ftpResponse.body, {
				status: ftpResponse.status,
				statusText: ftpResponse.statusText,
				headers,
			});
		}

		const backendRequest = buildBackendRequest(request, dstUrl, dstUrlStr);
		// Trace(6) 级别: 记录发往上游的完整请求头 (凭证脱敏, 请求 body 为流式透传, 不落日志)
		// Trace(6) level: log full outbound request headers (credentials redacted; the request body is streamed through and never logged)
		console.trace("outbound backend request", {
			func,
			method: backendRequest.method,
			url: loggableDst,
			headers: redactHeaders(backendRequest.headers),
		});

		let backendResponse: Response;
		try {
			backendResponse = await fetch(backendRequest);
		} catch (e) {
			console.error("backend fetch failed", { func, error: String(e), dstUrlStr: loggableDst });
			return new Response("Bad gateway", { status: 502, statusText: "Bad gateway" });
		}
		if (backendResponse.status !== 200) {
			// 只记录状态, 不打印完整响应对象, 避免目标响应头中的凭证进入日志
			// log the status only, never the whole response object, so credentials in backend headers stay out of logs
			console.warn("backend responded with non-200 status", { func, status: backendResponse.status, dstUrlStr: loggableDst });
		}

		const responseHeaders = buildResponseHeaders(request, env, url, backendResponse);
		const contentType = backendResponse.headers.get("content-type") ?? "";
		const isText = TEXT_CONTENT_MARKERS.some((m) => contentType.includes(m));
		console.debug("backend response classified", { func, contentType, isText, originalContent });

		if (originalContent || !isText) {
			// 直通: 不读 body, 保留 content-encoding (Workers passthrough 的合法前提)
			// passthrough: do not read the body, keep content-encoding (the legal precondition for Workers passthrough)
			return new Response(backendResponse.body, {
				status: backendResponse.status,
				statusText: backendResponse.statusText,
				headers: responseHeaders,
			});
		}

		// 文本改写: text() 读出的是解压后内容, 必须剥离过期的 content-encoding/content-length
		// text rewriting: text() yields decompressed content, stale content-encoding/content-length must be stripped
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("content-length");
		// 以重定向后的最终地址为基准 (redirect: "follow" 时预解析 host 可能已失效)
		// base URL rewriting on the post-redirect final address (the pre-parsed host may be stale under redirect: "follow")
		const finalUrl = new URL(backendResponse.url || dstUrlStr);
		const body = rewriteTextBody(await backendResponse.text(), url, finalUrl);
		console.debug("text body rewritten", { func, finalHost: finalUrl.host });
		return new Response(body, {
			status: backendResponse.status,
			statusText: backendResponse.statusText,
			headers: responseHeaders,
		});
	},
} satisfies ExportedHandler<Env>;

/** 校验访问令牌; 通过返回 null, 拒绝返回错误响应 (fail-closed) / Validate the access token; null on success, an error response when rejected (fail-closed) */
function checkProxyToken(request: Request, env: Env, url: URL): Response | null {
	const func = "src.index.checkProxyToken";
	// wrangler types 将 vars 值字面量化为 "", 运行时被 secret 覆盖为任意字符串, 显式放宽
	// wrangler types literalizes vars values as "", at runtime the secret overrides them with an arbitrary string; widen explicitly
	const expected: string = env.PROXY_TOKEN;
	if (!expected) {
		console.warn("PROXY_TOKEN is not configured, rejecting request (fail-closed)", { func });
		return new Response("Proxy is not configured with an access token. Set it via `wrangler secret put PROXY_TOKEN`.", {
			status: 503,
			statusText: "Service unavailable",
		});
	}
	const provided = request.headers.get(PROXY_TOKEN_HEADER) ?? url.searchParams.get(PROXY_TOKEN_QUERY) ?? "";
	if (!secureEqual(provided, expected)) {
		console.warn("invalid or missing proxy token", { func });
		return new Response("Forbidden", { status: 403, statusText: "Forbidden" });
	}
	console.debug("proxy token verified", { func });
	return null;
}

/**
 * 解析目的 URL: 从 pathname 前缀取值 (替代旧版 "第二次出现 http 的位置" 的脆弱取法),
 * 只接受 http(s) 绝对地址, 并拒绝指向代理自身的回环请求
 *
 * Parse the destination URL: take it from the pathname prefix (replacing the fragile
 * "second occurrence of http" approach), accept absolute http(s) addresses only,
 * and reject loops pointing back at the proxy itself
 */
function parseDestinationUrl(url: URL): ParsedDestination {
	const func = "src.index.parseDestinationUrl";
	// 认证参数从查询串剥离, 不混入目的 URL / strip the auth parameter from the query string so it never leaks into the destination URL
	if (url.searchParams.has(PROXY_TOKEN_QUERY)) url.searchParams.delete(PROXY_TOKEN_QUERY);

	let path = url.pathname;
	let originalContent = false;
	if (path.startsWith(ORIGINAL_CONTENT_PREFIX)) {
		originalContent = true;
		path = path.slice(ORIGINAL_CONTENT_PREFIX.length - 1); // "/~~/https://x" -> "/https://x"
	}
	const dstUrlStr = path.slice(1) + url.search;

	if (!/^(https?|ftp):\/\//i.test(dstUrlStr)) {
		console.warn("destination rejected: must start with http(s):// or ftp://", { func });
		return { error: "Invalid Destination URL", status: 400 };
	}
	const dstUrl = new URL(dstUrlStr);
	if (dstUrl.host === url.host) {
		console.warn("destination rejected: proxy loop detected", { func });
		return { error: "Proxy loop detected", status: 400 };
	}
	console.debug("destination accepted", { func, dstUrlStr: redactUrlCredentials(dstUrl), originalContent });
	return { dstUrl, dstUrlStr, originalContent };
}

/** 构造发往上游的请求: 剥离凭证类请求头, 强制禁用缓存 / Build the outbound request: strip credential headers, force no-store */
function buildBackendRequest(request: Request, dstUrl: URL, dstUrlStr: string): Request {
	const func = "src.index.buildBackendRequest";
	const headers = new Headers(request.headers);
	// 安全修复: 代理域 Cookie 不转发 (避免共享 cookie jar 的跨目标泄露); 访问令牌同样不转发
	// security fix: proxy-domain cookies are not forwarded (avoids cross-destination leaks via the shared cookie jar); the access token is not forwarded either
	headers.delete("cookie");
	headers.delete(PROXY_TOKEN_HEADER);
	headers.set("host", dstUrl.host);
	headers.set("pragma", "no-store");
	headers.set("cache-control", "no-store");
	const method = request.method.toUpperCase();
	const bodyAllowed = method !== "GET" && method !== "HEAD";
	console.debug("backend request built", { func, method: request.method, dstUrlStr: redactUrlCredentials(dstUrl) });
	return new Request(dstUrlStr, {
		method: request.method,
		headers,
		// GET/HEAD 携带 body 会让 Request 构造抛 TypeError, 显式丢弃
		// a body on GET/HEAD makes the Request constructor throw a TypeError; drop it explicitly
		body: bodyAllowed ? request.body : undefined,
		redirect: "follow",
	});
}

/** 构造返回给客户端的响应头: 剥离 Set-Cookie, 白名单 CORS, 总是应用受限 CSP / Build client-facing response headers: strip Set-Cookie, allowlist CORS, always apply the restrictive CSP */
function buildResponseHeaders(request: Request, env: Env, url: URL, backendResponse: Response): Headers {
	const func = "src.index.buildResponseHeaders";
	const headers = new Headers(backendResponse.headers);
	// 安全修复: 不透传目标的 Set-Cookie (所有被代理目标共享代理域 cookie jar 会造成跨站点泄露)
	// security fix: never forward the destination's Set-Cookie (all proxied targets share the proxy-domain cookie jar, which would leak data across sites)
	headers.delete("set-cookie");
	headers.set("cache-control", "no-store");

	// CORS: 只允许代理自身来源与显式配置的白名单, 不再反射请求方可控的 Host 头
	// CORS: only the proxy's own origin or the explicit allowlist is allowed; the client-controlled Host header is no longer reflected
	const origin = request.headers.get("origin");
	const allowedOriginsConfig: string = env.ALLOWED_ORIGINS;
	const allowedOrigins = allowedOriginsConfig ? allowedOriginsConfig.split(",").map((s) => s.trim()) : [];
	if (origin && (origin === url.origin || allowedOrigins.includes(origin))) {
		headers.set("access-control-allow-origin", origin);
		headers.set("access-control-allow-headers", "Authorization");
		headers.append("vary", "Origin");
	}

	// 总是应用受限 CSP (旧版仅在目标自带 CSP 时替换, 无 CSP 目标会以代理源全权运行)
	// always apply the restrictive CSP (the old version replaced it only when the destination had one, letting CSP-less content run with full proxy-origin privileges)
	headers.set("content-security-policy", buildCsp(url.host));
	console.debug("response headers built", { func });
	return headers;
}

/** 受限 CSP 模板: 所有资源只能来自代理自身; script-src 加 'unsafe-inline' 以兼容依赖内联脚本的目标 / Restrictive CSP template: all resources must come from the proxy itself; script-src adds 'unsafe-inline' to keep inline-script destinations working */
function buildCsp(proxyHost: string): string {
	const func = "src.index.buildCsp";
	console.debug("building csp", { func, proxyHost });
	return [
		"default-src 'none'",
		"base-uri 'self'",
		`child-src ${proxyHost}/`,
		`connect-src 'self' ${proxyHost}`,
		`font-src ${proxyHost}`,
		"form-action 'self'",
		"frame-ancestors 'none'",
		`frame-src ${proxyHost}`,
		`img-src 'self' data: blob: ${proxyHost}`,
		"manifest-src 'self'",
		`media-src ${proxyHost}`,
		`script-src 'unsafe-inline' ${proxyHost}`,
		`style-src 'unsafe-inline' ${proxyHost}`,
		"upgrade-insecure-requests",
		`worker-src ${proxyHost}/`,
	].join("; ");
}

/** 改写文本响应中的 URL, 让页面内链接继续经由代理 / Rewrite URLs in text responses so in-page links keep going through the proxy */
function rewriteTextBody(body: string, proxyUrl: URL, finalUrl: URL): string {
	const func = "src.index.rewriteTextBody";
	const proxyBase = `${proxyUrl.protocol}//${proxyUrl.host}`;
	let text = body;
	// 1. 绝对 http(s) 地址 -> 经代理 / absolute http(s) URLs -> through the proxy
	text = text.replaceAll(/(https?:\/\/)/gi, `${proxyBase}/$1`);
	// 2. 引号内绝对路径 "/path" -> 经代理指向重定向后的最终主机 / quoted absolute paths "/path" -> proxied, pointing at the post-redirect final host
	text = text.replaceAll(/(["'])\/(\w\S*)(["'])/gi, `$1${proxyBase}/${finalUrl.protocol}//${finalUrl.host}/$2$3`);
	// 3. 协议相对地址 "//host/path" -> 经代理指向展开后的绝对地址 / protocol-relative "//host/path" -> proxied, expanded into an absolute address
	text = text.replaceAll(/(["'])\/\/(\S*)(["'])/gi, `$1${proxyBase}/${finalUrl.protocol}//$2$3`);
	// 注意: 正则改写会波及 JSON/JS 字符串值 (如 API 返回的 url 字段), 属于该方案的固有局限
	// note: regex rewriting also hits JSON/JS string values (e.g. url fields in API payloads); an inherent limitation of this approach
	console.debug("text rewritten", { func, finalHost: finalUrl.host });
	return text;
}

/** 常量时间字符串比较, 避免逐字节短路造成的时序侧信道 / Constant-time string comparison, avoiding the timing side channel of byte-wise early exit */
function secureEqual(a: string, b: string): boolean {
	const func = "src.index.secureEqual";
	const encoder = new TextEncoder();
	const ea = encoder.encode(a);
	const eb = encoder.encode(b);
	if (ea.length !== eb.length) {
		console.debug("token comparison: length mismatch", { func });
		return false;
	}
	let diff = 0;
	for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
	console.debug("token comparison done", { func });
	return diff === 0;
}

/** Trace 日志用: 凭证类请求头脱敏 (安全约定: 日志不输出任何 token) / For trace logs: redact credential-like headers (security rule: never log any token) */
function redactHeaders(headers: Headers): Record<string, string> {
	const func = "src.index.redactHeaders";
	const redacted: Record<string, string> = {};
	for (const [name, value] of headers.entries()) {
		redacted[name] = /authorization|cookie|proxy-token/i.test(name) ? "[REDACTED]" : value;
	}
	console.debug("headers redacted for tracing", { func });
	return redacted;
}
