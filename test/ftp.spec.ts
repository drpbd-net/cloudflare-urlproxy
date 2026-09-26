import { afterEach, describe, expect, it } from "vitest";
import {
	fetchFtp,
	ftpCredentials,
	guessContentType,
	parseEpsvPort,
	parseFtpResponseLine,
	parsePasvPort,
	renderDirectoryListing,
	redactUrlCredentials,
	sanitizeFtpArg,
	setFtpConnectorForTesting,
} from "../src/ftp";
import { installFtpFakes } from "./ftp-helpers";

const PROXY_BASE = "https://proxy.example.com/";
const stripCrlf = (s: string) => s.replace(/\r\n$/, "");

afterEach(() => {
	setFtpConnectorForTesting(null);
});

describe("ftp protocol parsing", () => {
	it("parses single and multi line response headers", () => {
		expect(parseFtpResponseLine("220 ready")).toEqual({ code: 220, isFinal: true });
		expect(parseFtpResponseLine("230-first line")).toEqual({ code: 230, isFinal: false });
		expect(parseFtpResponseLine("garbage")).toBeNull();
		expect(parseFtpResponseLine("")).toBeNull();
	});

	it("parses EPSV and PASV data ports", () => {
		expect(parseEpsvPort("229 Entering Extended Passive Mode (|||2121|)")).toBe(2121);
		expect(parseEpsvPort("229 no parens here")).toBeNull();
		// PASV: 忽略服务器返回的 IP (NAT 场景常是内网地址), 只取端口 / PASV: ignore the server-returned IP (often internal under NAT), take the port only
		expect(parsePasvPort("227 Entering Passive Mode (192,168,1,10,39,15)")).toBe(39 * 256 + 15);
		expect(parsePasvPort("227 bad format")).toBeNull();
	});
});

describe("ftp url credentials", () => {
	it("defaults to anonymous when no credentials are embedded", () => {
		expect(ftpCredentials(new URL("ftp://h.example/pub/"))).toEqual({ user: "anonymous", password: "anonymous@" });
	});

	it("decodes percent-encoded embedded credentials", () => {
		expect(ftpCredentials(new URL("ftp://alice:p%40ss@h.example/x"))).toEqual({ user: "alice", password: "p@ss" });
	});

	it("redacts credentials for logging", () => {
		expect(redactUrlCredentials(new URL("ftp://alice:secret@h.example/x"))).toBe("ftp://alice:***@h.example/x");
		expect(redactUrlCredentials(new URL("https://h.example/x?a=1"))).toBe("https://h.example/x?a=1");
	});
});

describe("ftp helpers", () => {
	it("strips CR/LF to prevent FTP command injection", () => {
		expect(sanitizeFtpArg("a\r\nDELE x")).toBe("aDELE x");
	});

	it("guesses content types from file extensions", () => {
		expect(guessContentType("/pub/data.json")).toBe("application/json");
		expect(guessContentType("/pub/photo.PNG")).toBe("image/png");
		expect(guessContentType("/pub/unknown.xyz")).toBe("application/octet-stream");
		expect(guessContentType("/pub/noext")).toBe("application/octet-stream");
	});

	it("renders an escaped HTML directory listing with proxy links", () => {
		const html = renderDirectoryListing(new URL("ftp://h.example/pub/"), PROXY_BASE, ["<script>alert(1)</script>", "a&b"]);
		expect(html).toContain("Index of ftp://h.example/pub/");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("a&amp;b");
		// 链接经代理, 文件名已编码 / links go through the proxy, names are URL-encoded
		expect(html).toContain(`${PROXY_BASE}ftp://h.example/pub/${encodeURIComponent("<script>alert(1)</script>")}`);
		// 非根目录提供父目录链接 / non-root directories get a parent link
		expect(html).toContain(`href="${PROXY_BASE}ftp://h.example/"`);
	});

	it("keeps embedded credentials in listing links", () => {
		const html = renderDirectoryListing(new URL("ftp://alice:p%40ss@h.example/pub/"), PROXY_BASE, ["x"]);
		expect(html).toContain("ftp://alice:p%40ss@h.example/pub/x");
	});
});

describe("fetchFtp sessions", () => {
	it("retrieves a file over a passive FTP session", async () => {
		const fakes = installFtpFakes(
			[
				"220 ready\r\n",
				"331 password required\r\n",
				"230 logged in\r\n",
				"200 binary ok\r\n",
				"229 Entering Extended Passive Mode (|||9999|)\r\n",
				"150 opening BINARY connection\r\n",
				"226 transfer complete\r\n",
				"221 bye\r\n",
			],
			[["file-bytes"]],
		);
		const pending: Promise<unknown>[] = [];
		const response = await fetchFtp(new URL("ftp://files.example.com/pub/file.bin"), (p) => pending.push(p), PROXY_BASE);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("file-bytes");
		expect(fakes.calls.control).toEqual({ hostname: "files.example.com", port: 21 });
		expect(fakes.calls.data).toEqual([{ hostname: "files.example.com", port: 9999 }]);
		// waitUntil 注入的后台收尾: 等 226, 发 QUIT, 关闭控制连接 / background finalization via waitUntil: await 226, send QUIT, close the control connection
		await Promise.all(pending);
		expect(fakes.control.sent.map(stripCrlf)).toEqual([
			"USER anonymous",
			"PASS anonymous@",
			"TYPE I",
			"EPSV",
			"RETR /pub/file.bin",
			"QUIT",
		]);
		expect(fakes.control.closed).toBe(true);
	});

	it("falls back from PASV when EPSV is unsupported", async () => {
		const fakes = installFtpFakes(
			[
				"220 ready\r\n",
				"331 pass\r\n",
				"230 ok\r\n",
				"200 type\r\n",
				"500 EPSV not supported\r\n",
				"227 Entering Passive Mode (0,0,0,0,39,15)\r\n",
				"150 opening\r\n",
				"226 done\r\n",
				"221 bye\r\n",
			],
			[["file-bytes"]],
		);
		const pending: Promise<unknown>[] = [];
		const response = await fetchFtp(new URL("ftp://files.example.com/pub/file.txt"), (p) => pending.push(p), PROXY_BASE);
		expect(await response.text()).toBe("file-bytes");
		expect(response.headers.get("content-type")).toBe("text/plain");
		await Promise.all(pending);
		expect(fakes.control.sent.map(stripCrlf)).toEqual([
			"USER anonymous",
			"PASS anonymous@",
			"TYPE I",
			"EPSV",
			"PASV",
			"RETR /pub/file.txt",
			"QUIT",
		]);
		expect(fakes.calls.data).toEqual([{ hostname: "files.example.com", port: 39 * 256 + 15 }]);
	});

	it("renders an HTML directory listing for directory paths", async () => {
		const fakes = installFtpFakes(
			[
				"220 ready\r\n",
				"331 pass\r\n",
				"230 ok\r\n",
				"200 type\r\n",
				"229 entering (|||9998|)\r\n",
				"150 opening\r\n",
				"226 done\r\n",
				"221 bye\r\n",
			],
			[["sub\r\n", "hello world.txt\r\n"]],
		);
		const response = await fetchFtp(new URL("ftp://files.example.com/pub/"), () => {}, PROXY_BASE);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const html = await response.text();
		expect(html).toContain("Index of ftp://files.example.com/pub/");
		expect(html).toContain(`href="${PROXY_BASE}ftp://files.example.com/pub/hello%20world.txt"`);
		expect(fakes.control.sent.map(stripCrlf)).toContain("NLST /pub/");
	});

	it("falls back to a directory listing when RETR reports 550", async () => {
		const fakes = installFtpFakes(
			[
				"220 ready\r\n",
				"331 pass\r\n",
				"230 ok\r\n",
				"200 type\r\n",
				"229 entering (|||9998|)\r\n",
				"550 no such file\r\n",
				"229 entering (|||9997|)\r\n",
				"150 opening\r\n",
				"226 done\r\n",
				"221 bye\r\n",
			],
			[[], ["sub\r\n"]],
		);
		const response = await fetchFtp(new URL("ftp://files.example.com/pub"), () => {}, PROXY_BASE);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Index of ftp://files.example.com/pub");
		expect(fakes.control.sent.map(stripCrlf)).toContain("NLST /pub");
	});

	it("returns 404 when neither RETR nor NLST succeeds", async () => {
		installFtpFakes(
			[
				"220 ready\r\n",
				"331 pass\r\n",
				"230 ok\r\n",
				"200 type\r\n",
				"229 entering (|||9998|)\r\n",
				"550 no file\r\n",
				"229 entering (|||9997|)\r\n",
				"550 no dir\r\n",
			],
			[[], []],
		);
		const response = await fetchFtp(new URL("ftp://files.example.com/missing"), () => {}, PROXY_BASE);
		expect(response.status).toBe(404);
	});

	it("returns 403 when FTP login fails", async () => {
		installFtpFakes(["220 ready\r\n", "331 password required\r\n", "530 login failed\r\n"]);
		const response = await fetchFtp(new URL("ftp://alice:badpass@files.example.com/"), () => {}, PROXY_BASE);
		expect(response.status).toBe(403);
	});

	it("returns 502 when the control connection cannot be established", async () => {
		installFtpFakes([], [], { rejectOpened: true });
		const response = await fetchFtp(new URL("ftp://files.example.com/x"), () => {}, PROXY_BASE);
		expect(response.status).toBe(502);
	});
});
