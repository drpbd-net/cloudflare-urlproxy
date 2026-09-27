/**
 * PROXY_TOKEN 以 secret 形式绑定, 不在 wrangler.jsonc 的 vars 中,
 * 因此不会出现在 `wrangler types` 生成的 worker-configuration.d.ts 里, 在此通过声明合并补全类型。
 * (vars 与 secret 同名会导致每次 deploy 用 vars 值覆盖远程 secret)
 * 支持逗号分隔的多个令牌, 任一匹配即通过; 令牌本身不能包含逗号。
 *
 * PROXY_TOKEN is bound as a secret and is absent from wrangler.jsonc's vars, so it does not
 * appear in the `wrangler types`-generated worker-configuration.d.ts; the type is restored here
 * via declaration merging. (A vars/secret name collision would make every deploy overwrite the
 * remote secret with the vars value.)
 * Multiple comma-separated tokens are supported, any one matching passes; a token itself
 * cannot contain a comma.
 */
declare global {
	interface Env {
		PROXY_TOKEN: string;
	}
}

export {};
