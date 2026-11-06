/**
 * MCP 授权（2026-07-28 版 Authorization 一章）里能逐字核对的部分：
 *   - MCP 服务器是 OAuth 2.1 的资源服务器，必须实现 OAuth 2.0 Protected Resource Metadata（RFC 9728）；
 *   - 不带令牌的请求回 401，WWW-Authenticate 里用 resource_metadata 指向元数据文档，可以带 scope；
 *   - 元数据文档的位置：先试插在端点路径前的 /.well-known/oauth-protected-resource/mcp，再试根上的 /.well-known/oauth-protected-resource；
 *   - 文档里 authorization_servers 至少一个；客户端再按顺序试授权服务器的元数据地址（RFC 8414 和 OpenID Connect Discovery）；
 *   - 授权请求和令牌请求都要带 resource 参数（RFC 8707），值是 MCP 服务器的规范 URI；PKCE；令牌放在 Authorization: Bearer 头里，
 *     不能放在查询串里；令牌不对或过期回 401，权限不够回 403 加 error="insufficient_scope"。
 * PKCE 的 code_challenge 要 SHA-256，本站不实现，课程里写成示例值。stdio 传输不走这套，从环境变量取凭据。
 */

export const PRM_SUFFIX = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_name?: string;
}

/** RFC 9728 的元数据文档（本站只写课程用到的字段，字段名照 RFC）。 */
export function protectedResourceMetadata(resource: string, authorizationServers: string[], options: { scopes?: string[]; name?: string } = {}): ProtectedResourceMetadata {
  if (!authorizationServers.length) throw new Error('MCP 要求 authorization_servers 至少有一个');
  return {
    resource,
    authorization_servers: authorizationServers,
    ...(options.scopes ? { scopes_supported: options.scopes } : {}),
    bearer_methods_supported: ['header'],
    ...(options.name ? { resource_name: options.name } : {}),
  };
}

/** 没有 resource_metadata 时客户端依次试的地址：端点有路径时先试插入路径的，再试根上的。 */
export function prmUrls(endpoint: string): string[] {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/$/, '');
  const root = `${url.origin}${PRM_SUFFIX}`;
  return path ? [`${url.origin}${PRM_SUFFIX}${path}`, root] : [root];
}

/** 授权服务器元数据的地址，按 MCP 规定的顺序：issuer 有路径时三个，没有时两个。 */
export function asMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  if (!path) return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`, `${url.origin}${path}/.well-known/openid-configuration`];
}

/** 401 / 403 的 WWW-Authenticate 头：Bearer resource_metadata="…"，可选 scope、error。 */
export function wwwAuthenticate(options: { resourceMetadata: string; scope?: string; error?: string }): string {
  const parts = [`resource_metadata="${options.resourceMetadata}"`];
  if (options.scope) parts.push(`scope="${options.scope}"`);
  if (options.error) parts.unshift(`error="${options.error}"`);
  return `Bearer ${parts.join(', ')}`;
}

/** 解析 WWW-Authenticate：方案和参数（只支持带引号或不带引号的 token=value 列表）。 */
export function parseWwwAuthenticate(value: string): { scheme: string; params: Record<string, string> } {
  const space = value.indexOf(' ');
  const scheme = space < 0 ? value : value.slice(0, space);
  const params: Record<string, string> = {};
  for (const match of value.slice(space + 1).matchAll(/([a-zA-Z_][\w-]*)=(?:"([^"]*)"|([^,\s]+))/g)) params[match[1]] = match[2] ?? match[3];
  return { scheme, params };
}

export interface AuthorizeParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  /** MCP 服务器的规范 URI（RFC 8707 的 resource）。 */
  resource: string;
}

/** 授权请求的地址：response_type=code、PKCE（S256）、resource。参数顺序是本站的写法。 */
export function authorizationUrl(params: AuthorizeParams): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    resource: params.resource,
  });
  return `${params.authorizationEndpoint}?${query.toString()}`;
}
