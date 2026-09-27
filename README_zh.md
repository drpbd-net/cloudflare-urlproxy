# cloudflare-urlproxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iceking2nd/cloudflare-urlproxy)

[English](./README.md) | 简体中文

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

### FTP 目标

`fetch()` 不支持 FTP 协议，代理基于 `cloudflare:sockets` 内置了最小 FTP 客户端（被动模式，EPSV 优先 / PASV 回退）：

```
https://<worker-host>/ftp://ftp.example.com/pub/file.txt    文件: 二进制流式直通, 按扩展名设 content-type
https://<worker-host>/ftp://ftp.example.com/pub/             目录: HTML 导航页, 链接继续经代理
```

支持 URL 内嵌凭据（`ftp://user:pass@host/`，密码会百分号解码后用于登录），无凭据时按匿名（anonymous）登录；目录页链接会保留已有凭据以便继续浏览。无尾斜杠的目录路径会先尝试文件（RETR），目标不存在时回退为目录列表。不支持 FTP 之外的协议（如 `ssh://`）仍返回 400。

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
| `PROXY_TOKEN` | 是 | 访问令牌，支持逗号分隔配置多个（任一匹配即通过；令牌本身不能包含逗号）。**只以 secret 形式设置**（`npx wrangler secret put PROXY_TOKEN`），不要放进 vars（同名 vars 会在每次部署时覆盖远程 secret）。未配置时 fail-closed，拒绝所有代理请求（503） |
| `ALLOWED_ORIGINS` | 否 | 额外允许跨域读取代理响应的来源，逗号分隔，如 `https://app.example.com` |

### 本地开发

在项目根目录创建 `.dev.vars`（已被 `.gitignore` 覆盖，勿提交）：

```
# 多 token 用逗号分隔 / multiple tokens, comma-separated
PROXY_TOKEN=dev-token,dev-token-2
```

然后：

```sh
npm install
npm run dev
```

## 部署

`wrangler.jsonc` 在仓库内始终保持**示例状态**（observability 关闭、自定义域名为占位符）。生产部署一律使用临时配置文件，不动仓库里的示例：

### 方式一：Cloudflare Dashboard 一键部署

点击页面顶部的 **Deploy to Cloudflare** 按钮，按引导把仓库连接到你的 Cloudflare 账号并部署。部署完成后在 dashboard 的 Settings → Variables 中设置 `PROXY_TOKEN` secret（不设置则所有请求被拒绝）。

### 方式二：临时配置文件手动部署

```sh
cp wrangler.jsonc wrangler.prod.jsonc       # wrangler.prod.jsonc 已被 .gitignore 忽略
# 编辑 wrangler.prod.jsonc: name、routes（你的自定义域名）、按需开启 observability
npx wrangler deploy --config wrangler.prod.jsonc
npx wrangler secret put PROXY_TOKEN --config wrangler.prod.jsonc   # fail-closed: 设置前所有请求被拒绝
rm wrangler.prod.jsonc
```

示例配置已按生产最佳实践预置：**workers.dev 默认域名与预览 URL 均已关闭**（`workers_dev: false` + `preview_urls: false`），仅通过自定义域名暴露。

## 安全设计

- **fail-closed 认证**：`PROXY_TOKEN` 未配置时拒绝一切代理请求；支持逗号分隔多个令牌（空段自动过滤，全空视为未配置）；令牌使用常量时间比较，多令牌全量遍历、不提前退出，时序不泄露命中的是哪一个
- **凭证隔离**：代理域 `Cookie` 与访问令牌不转发给目标；目标的 `Set-Cookie` 不透传（各被代理目标不共享代理域 cookie jar）；`Authorization` 属客户端显式凭证，保留转发
- **CSP**：始终应用受限 CSP，被代理页面只能从代理自身加载资源、只能向代理发送请求
- **CORS**：仅允许代理自身来源或 `ALLOWED_ORIGINS` 白名单，不反射请求方可控的头
- **输入校验**：目的地址必须是 `http(s)://` 或 `ftp://` 绝对地址；拒绝指向代理自身的回环请求（400）；FTP 命令参数剥离 CR/LF 防注入
- **日志脱敏**：非 200 状态只记录状态与 URL；URL 凭据一律 `user:***@`；trace 级日志中的凭证类头一律 `[REDACTED]`

## 已知局限

- URL 改写基于正则，会波及文本中所有 `http(s)://` 与引号内绝对路径，包括 JSON/JS 字符串值（如 API 返回的 `url` 字段），下游消费方可能解析失败；需要原始内容时使用 `/~~/` 模式
- 因剥离 `Set-Cookie`，依赖 cookie 会话的目标站点无法保持登录态（安全与功能的取舍）
- CSP 的 `script-src` 含 `'unsafe-inline'`，以兼容依赖内联脚本的站点
- FTP 支持仅为**明文 FTP**（无 FTPS），登录密码以明文穿越代理与服务器，仅建议用于匿名或非敏感资源；日志中的 FTP URL 凭据一律脱敏，但目录页链接会（经转义）保留 URL 中已有的凭据——请勿分享此类链接
- FTP 被动模式忽略 PASV 响应返回的 IP（始终回连控制连接的主机，规避 NAT 场景）；每个 FTP 请求占用 2 个并发 TCP 连接（控制 + 数据），受 Workers 同时打开连接上限约束；Workers 无法连接 Cloudflare 自身 IP 段

## 开发

```sh
npm run dev     # 本地开发服务器
npm test        # vitest 测试（34 个用例：HTTP 代理行为 + FTP 协议会话，FakeSocket 回放，离线可重复）
npx tsc --noEmit -p tsconfig.json       # 主代码类型检查
npx tsc --noEmit -p test/tsconfig.json  # 测试代码类型检查
```

变更 `wrangler.jsonc` 中的绑定后运行 `npm run cf-typegen` 重新生成类型。

## 许可证

[MIT](./LICENSE)
