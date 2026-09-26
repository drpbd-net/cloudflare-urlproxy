/**
 * PROXY_TOKEN 以 secret 形式绑定, 不在 wrangler.jsonc 的 vars 中,
 * 因此不会出现在 `wrangler types` 生成的 worker-configuration.d.ts 里, 在此通过声明合并补全类型。
 * (vars 与 secret 同名会导致每次 deploy 用 vars 值覆盖远程 secret)
 *
 * PROXY_TOKEN is bound as a secret and is absent from wrangler.jsonc's vars, so it does not
 * appear in the `wrangler types`-generated worker-configuration.d.ts; the type is restored here
 * via declaration merging. (A vars/secret name collision would make every deploy overwrite the
 * remote secret with the vars value.)
 */
declare global {
	interface Env {
		PROXY_TOKEN: string;
	}
}

export {};
