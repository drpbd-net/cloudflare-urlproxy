# cloudflare-urlproxy

部署在 Cloudflare Workers 上的 URL 反向代理。访问 `https://<worker-host>/https://<目标地址>` 即可经由代理访问目标站点；文本响应中的链接会被自动改写，使页面内的后续请求继续经由代理。

## 用法

### 普通模式（文本响应自动改写）

```
https://<worker-host>/https://example.com/page
```

响应中的绝对地址、绝对路径（`"/path"`）与协议相对地址（`"//host/path"`）都会被改写为指向代理。

### 原样直通模式

```
https://<worker-host>/~~/https://example.com/page
```

不改动响应 body，其余行为（响应头处理、认证）不变。

### 认证

所有代理请求都需要访问令牌，两种方式任选：

```sh
# 请求头（适合程序调用）
curl -H "X-Proxy-Token: <token>" "https://<worker-host>/https://example.com/page"

# 查询参数（适合直接在浏览器地址栏使用，会被从转发给目标的 URL 中剥离）
https://<worker-host>/https://example.com/page?__proxy_token=<token>
```

## 配置

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `PROXY_TOKEN` | 是 | 访问令牌。生产环境用 secret 注入，未配置时 fail-closed，拒绝所有代理请求（503） |
| `ALLOWED_ORIGINS` | 否 | 额外允许跨域读取代理响应的来源，逗号分隔，如 `https://app.example.com` |

### 本地开发

在项目根目录创建 `.dev.vars`（已被 `.gitignore` 覆盖，勿提交）：

```
PROXY_TOKEN=dev-token
```

然后：

```sh
npm install
npm run dev
```

## 部署

```sh
npx wrangler secret put PROXY_TOKEN   # 先配置生产令牌，漏配会拒绝所有请求
npm run deploy
```

## 安全设计

- **fail-closed 认证**：`PROXY_TOKEN` 未配置时拒绝一切代理请求；令牌使用常量时间比较
- **凭证隔离**：代理域 `Cookie` 与访问令牌不转发给目标；目标的 `Set-Cookie` 不透传（各被代理目标不共享代理域 cookie jar）；`Authorization` 属客户端显式凭证，保留转发
- **CSP**：始终应用受限 CSP，被代理页面只能从代理自身加载资源、只能向代理发送请求
- **CORS**：仅允许代理自身来源或 `ALLOWED_ORIGINS` 白名单，不反射请求方可控的头
- **输入校验**：目的地址必须是 `http(s)://` 绝对地址；拒绝指向代理自身的回环请求（400）
- **日志脱敏**：非 200 状态只记录状态与 URL；trace 级日志中的凭证类头一律 `[REDACTED]`

## 已知局限

- URL 改写基于正则，会波及文本中所有 `http(s)://` 与引号内绝对路径，包括 JSON/JS 字符串值（如 API 返回的 `url` 字段），下游消费方可能解析失败；需要原始内容时使用 `/~~/` 模式
- 因剥离 `Set-Cookie`，依赖 cookie 会话的目标站点无法保持登录态（安全与功能的取舍）
- CSP 的 `script-src` 含 `'unsafe-inline'`，以兼容依赖内联脚本的站点

## 开发

```sh
npm run dev     # 本地开发服务器
npm test        # vitest 测试（17 个用例，含出站请求 mock）
npx tsc --noEmit -p tsconfig.json       # 主代码类型检查
npx tsc --noEmit -p test/tsconfig.json  # 测试代码类型检查
```

变更 `wrangler.jsonc` 中的绑定后运行 `npm run cf-typegen` 重新生成类型。

## 许可证

[MIT](./LICENSE)
