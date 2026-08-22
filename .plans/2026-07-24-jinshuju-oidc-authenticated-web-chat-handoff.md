# Eveland Identity：Internal Provider 首验与金数据 OIDC 第二阶段实施交接计划

日期：2026-07-24

> 状态：**部分完成。** Phase 0–7 已于 2026-07-27 收口；Phase 8–9（通用
> OIDC Adapter 与金数据 OIDC）未纳入已完成里程碑。
> 状态核对：2026-08-22。

主要平台：`/Users/michael/work/eveland`

聊天 UI：`/Users/michael/work/eve-chats`

首个验证 Agent：`/Users/michael/work/eve-wecom-greeter`

## 1. 最终目标

把身份做成 Eveland 的系统能力。先以 `Eveland Internal` 作为第一个 provider 验证完整
链路，再以金数据 OIDC 作为第二个 provider；两者在 Eveland Identity Broker 之后使用
同一套 contract：

```text
Eveland Internal ─┐
                  ├── provider adapter
金数据 OIDC ──────┘
         │
         ▼
Eveland Identity
    │ 中央 Browser Session
    │ 签发短时 Caller Token
    ▼
eve-chats
    │ 不知道当前使用 Internal 还是金数据
    │ 不保存 provider session/token
    │ 只转发当前请求携带的 Caller Token
    ▼
Eveland Gateway
    │ 保持 Agent-owned Authorization 透明转发
    ▼
Eve Agent
    │ evelandIdentity()
    ▼
ctx.session.auth.current
```

第一阶段用户体验（Eveland Internal）：

1. 用户打开 `eve-chats`；
2. Agent 列表可以在未登录时展示；
3. 用户点击一个 Eveland Agent；
4. 如果没有 Eveland Identity session，浏览器跳转到 Eveland；
5. Eveland Internal adapter 检查现有 Better Auth control-plane session；
6. 没有 Better Auth session 时进入现有 Eveland 登录，登录后只回 Eveland Identity；
7. Internal adapter 把经过验证的 Better Auth user 显式映射成独立的 Identity
   Principal/Realm，建立独立 Eveland Identity session，并跳回原 Agent 页面；
8. 浏览器向 Eveland 申请一个约 60 秒、绑定目标 Agent 的 Caller Token；
9. `eve-chats` 用该 token 调用 Agent；
10. Agent 的 `evelandIdentity()` 把 Identity Principal 投影成 Eve user principal；
11. Agent 回复：

   ```text
   Hello, 陈金洲。
   ```

第二阶段接入金数据 OIDC 时，只替换 5–7 的 provider adapter：

1. Eveland 根据 System 配置跳转到金数据 OIDC；
2. 金数据 callback 回到 Eveland，不回 `eve-chats`；
3. Eveland 从验证后的 provider response 解析 External Realm/Subject；
4. 后续 Identity Session、Caller Token、`eve-chats`、Gateway 和 Agent 流程完全不变。

点击第二个 Agent 时：

1. 浏览器仍携带 Eveland Identity session cookie；
2. Eveland 不再触发 Internal 登录或金数据登录；
3. Eveland 检查当前 Identity Realm 是否被授权访问第二个 Project；
4. 允许时直接签发新的 audience-bound Caller Token；
5. 第二个 Agent 得到相同 Principal 和内部 Realm 身份；
6. 未授权时返回 403，不通过重新登录绕过 Realm policy。

## 2. 关键架构决定

### 2.1 Eveland 是 Identity Broker

Eveland 负责：

- System 级 Identity Provider Connection 配置；
- provider-neutral 的登录编排与统一 identity finalization；
- Internal adapter 对 Better Auth session 的验证和显式身份映射；
- OIDC adapter 的 Authorization Code + PKCE、callback、ID Token/UserInfo 校验；
- 中央 Browser Identity Session；
- OIDC access/refresh token 的加密保存与刷新；
- Identity Principal 映射；
- 外部 Account/Corp/Workspace 到内部 Identity Realm 的精确映射；
- Identity Realm 到 Project 的集中授权；
- 短时 Caller Token 签发；
- 公共 JWKS；
- Caller Token 的 Agent audience 和用户授权。

Provider 顺序：

1. `Eveland Internal` 是第一个 provider，只把现有 Better Auth 登录作为身份来源；
2. 金数据 OIDC 是第二个 provider；
3. 两个 provider 都必须产出统一的 `ResolvedExternalIdentity`，再进入同一个
   `finalizeIdentity()`；
4. Better Auth control-plane session 不能直接成为 Identity Session、Caller Token 或
   Agent credential；
5. 金数据不是 Agent SDK 的一部分。

### 2.2 `eve-chats` 保持 IdP 无关

`eve-chats` 不知道：

- Better Auth cookie/session token 或 Internal adapter；
- 当前选中哪个 Identity Provider Connection；
- 金数据 issuer；
- 金数据 Client ID；
- 金数据 Client Secret；
- 金数据 callback；
- 金数据 access token；
- 金数据 refresh token；
- UserInfo endpoint。

它只知道 Eveland 的通用接口：

```text
GET  <EVELAND_IDENTITY_ORIGIN>/identity/session
GET  <EVELAND_IDENTITY_ORIGIN>/identity/login
POST <EVELAND_IDENTITY_ORIGIN>/identity/caller-tokens
GET  <EVELAND_IDENTITY_ORIGIN>/.well-known/jwks.json
```

本计划中的“无状态”是指身份无状态：

- `eve-chats` 不创建自己的登录 session；
- 不在数据库保存 identity token；
- 不保存 refresh token；
- 不参与 provider callback 或 identity finalization。

`eve-chats` 仍可保存 Agent catalog、chat、message、event、Eve session ID、
continuation token 和 stream cursor。这些是聊天状态，不是身份状态。

### 2.3 Agent 使用 `evelandIdentity()`

Agent 在现有 `agent/channels/eve.ts` 中使用：

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { evelandIdentity } from "@eveland/agent-identity";

export default eveChannel({
  auth: [
    evelandIdentity(),

    // 只有仍需接受 Vercel 调用时才保留。
    vercelOidc(),

    // 本地开发 fallback，放最后。
    localDev(),
  ],
});
```

如果 Agent 只运行在 Eveland：

```ts
export default eveChannel({
  auth: [
    evelandIdentity(),
    localDev(),
  ],
});
```

`eveChannel()` 提供标准 `/eve/v1/session*`、continuation 和 NDJSON stream。

### 2.4 Eveland System 配置一次

System 设置新增 managed identity provider。第一阶段：

```text
Provider type: Internal
Display name: Eveland Internal
Internal Realm key（创建后不可变）
Enabled
```

第二阶段新增：

```text
Provider type: OIDC
Display name: 金数据
Issuer
Client ID
Client Secret
Scopes
Authorization parameters（可选）
Token endpoint client authentication method
Enabled
```

这是平台级配置，不复制到 Project、Deployment 或 Agent connection。

所有显式包含 `evelandIdentity()` 的 Agent 都能接受同一 Eveland Identity
签发的 Caller Token。它们不需要知道上游 provider，也不需要自己的 OIDC Client。

只有一个 enabled provider 时 Eveland 自动选择。允许 Internal 与金数据同时 enabled
之后，provider 选择必须由 Eveland 托管的选择页或 System 默认策略完成；`eve-chats`
仍只调用通用 `/identity/login`，不通过 query string 任意指定 provider。

### 2.5 不偷偷修改 Agent 的认证边界

当前 Eveland 产品约束要求公开 Agent auth 由 Agent 拥有，Gateway 不能因为平台登录
就放松公开请求。

因此所有阶段：

- System 配置不会自动改写任意 Agent 源码；
- 不从源码 import、401 或 `WWW-Authenticate` 推断 auth；
- 首个验证 Agent 显式加入 `evelandIdentity()`；
- 新 Agent 模板以后可以默认包含该 helper；
- 批量迁移现有 Agent 是后续独立工作；
- Gateway 继续透明转发 `Authorization`；
- Agent route auth 仍然是最后的认证决定者。

“System 配置一次”消除的是逐 Agent provider/OIDC Client 配置，不是取消 Agent 对自身
route auth 的显式声明。

## 3. 六个身份概念必须分开

### 3.1 Control-plane Member

当前 Better Auth 管理 Eveland 管理后台的 admin/member。

它用于：

- 项目管理；
- 部署；
- System 设置；
- Playground；
- 团队邀请和权限。

不得把 control-plane member session 直接当成 Agent 用户身份。

### 3.2 Identity Provider Connection

Eveland 与一个身份来源之间的协议配置和信任关系，例如：

- `Internal`：验证现有 Better Auth session，并按显式规则映射 member；
- `OIDC`：一组金数据 issuer、Client ID、Client Secret 与 claim mapping。

它描述“如何验证来源身份”，不表示用户、公司或授权范围。一条 Connection 可以映射
一个或多个来源 Realm。即使 Internal provider 的自然人与 control-plane member 相同，
Connection、Principal、Realm 和 Identity Session 仍是独立记录。

### 3.3 Identity Principal

通过 Eveland Internal 或金数据 OIDC 登录、准备与 Agent 聊天的人。

稳定身份为：

```text
Identity Provider Connection + External Realm ID + External Subject
```

它可以与 control-plane member 是同一个自然人，但两个身份边界不能隐式合并。

### 3.4 Identity Realm

外部身份系统中的一个隔离边界，经 Eveland 映射成内部稳定 ID：

```text
Eveland Internal Realm
金数据 Account
企业微信 Corp
Slack Workspace / Enterprise
generic OIDC Tenant / Organization
  → Eveland Identity Realm（irlm_...）
```

授权和 Agent 数据隔离使用内部 `irlm_...`，不使用公司名称、email domain、Slack
workspace 名称或浏览器提交的 Account 参数。

### 3.5 Eveland Identity Session

只存在于 Eveland Identity origin：

- HttpOnly；
- Secure；
- SameSite 按部署拓扑配置；
- cookie 中仅保存高熵随机 token；
- 数据库保存 token hash；
- 可撤销、可过期；
- 绑定一个 `active_identity_realm_id`；
- 第二个 Agent 重用该 session。

实验阶段采用：

```text
一个 Identity Session = 一个 active Identity Realm
```

切换 Account/Corp/Workspace 时必须显式切换 Realm 并轮换 session，不能在一个
session 中静默合并多个 Realm 的权限。

### 3.6 Agent Caller

由 Agent 收到的 Eveland Caller Token 和 `evelandIdentity()` 建立。

进入：

```ts
ctx.session.auth.current
ctx.session.auth.initiator
```

它不是金数据 access token、Better Auth session/token 或 control-plane member ID。

### 3.7 术语使用规则

内部 contract、数据库和 token 统一使用：

- `Identity Provider Connection`：外部身份提供方连接；
- `Identity Realm`：内部授权与隔离边界；
- `Identity Principal`：Realm 内的用户主体。

其他词只在明确边界内使用：

- `Account`、`Corp`、`Workspace`、`Enterprise`、`Tenant` 以及 provider 原生的
  `Organization` 标签，只出现在 adapter 输入、provider 配置和面向用户的 provider
  文案中；
- Eveland 内部不加限定的 `Organization` 保留给现有 Better Auth Organization/Team，
  不能表示 Agent-user Identity Realm；
- `domain` 只表示 DNS、email 或 Cookie domain，不能表示身份或授权边界；
- Eveland 内部模型不使用 `tenant` 作为 Realm 的别名。

## 4. 组件依赖关系

目标依赖：

```text
eve-chats
  → Eveland Identity public contract
  → Eve canonical Agent protocol

Eveland Identity
  → provider-neutral login orchestration
  → Internal adapter → verified Better Auth session
  → OIDC adapter → generic OIDC protocol → configured Jinshuju issuer
  → Eveland DB and secret encryption

Gateway
  → route resolution
  → trusted platform headers
  → transparent Agent Authorization forwarding

Agent
  → Eve
  → @eveland/agent-identity verifier

Agent -X-> Better Auth session/token
Agent -X-> Jinshuju
eve-chats -X-> Better Auth session/token
eve-chats -X-> Jinshuju
Gateway -X-> Better Auth session/token
Gateway -X-> Jinshuju Client Secret
```

不存在 callback 循环：

```text
Better Auth 登录完成 → Eveland Identity Internal continuation
金数据 callback → Eveland Identity
Eveland login return → allowlisted eve-chats URL
```

Agent 是由 Eveland 部署还是从 Eveland catalog 获取，不影响 provider callback 所属。

## 5. Eveland 包与应用边界

建议的代码所有权：

```text
packages/core
  identity contracts、ID 格式、公共 DTO

packages/db
  provider connection/realm/principal/session/transaction/token repositories

packages/identity-broker（新增，可选）
  provider-neutral login/finalization
  Internal 与 OIDC adapters
  Caller Token claims/signing
  不直接依赖具体 app

packages/agent-identity（新增）
  evelandIdentity() Eve AuthFn
  只验证 Eveland Caller Token

apps/api
  System provider routes
  login/internal continuation/OIDC callback/session/caller-token routes
  cookie、CORS、Store 和 secret composition

apps/web
  admin-only System Identity 设置

apps/gateway
  不保存 Better Auth Agent-user credential
  不保存 OIDC provider secret
  不创建 Identity Session
  继续透明转发 Agent Authorization
```

遵守现有依赖方向：

```text
apps → packages
db → core
core → no other Eveland package
apps -X-> apps
```

不要把 identity realm behavior 堆进 `apps/api/src/app.ts` 或
`packages/db/src/store.ts`。

## 6. System Identity Provider Connection

### 6.1 数据模型

建议新增：

```text
identity_provider_connections
  id
  type = internal | oidc
  display_name
  internal_realm_key（Internal 必填、创建后不可变）
  issuer（OIDC 必填）
  client_id（OIDC 必填）
  client_secret_encrypted（OIDC 按 auth method 必填）
  scopes（OIDC 必填）
  authorization_parameters_json（OIDC 可选）
  token_endpoint_auth_method（OIDC 必填）
  external_realm_resolution =
    connection | internal_member | id_token_claim | userinfo_claim | provider_api
  external_realm_claim（OIDC claim 模式时必填）
  enabled
  security_revision
  created_at
  updated_at
```

第一阶段只允许一个 enabled `Internal` Connection。第二阶段加入金数据 OIDC，并支持
Internal 与 OIDC 同时 enabled；数据模型、session 和 token 从一开始就不能假设只有
OIDC，也不能把“金数据”写死为 enum。

要求：

- Internal adapter 只能接受服务端验证过的 Better Auth session；
- Internal adapter 的 `externalSubject` 使用验证后的稳定 `session.user.id`，不使用
  Organization membership ID、email 或 name；
- Internal adapter 的 `externalRealmId` 使用 Connection 上不可变的 realm key；
- 不把 Better Auth cookie/session token 复制到 Identity Session、Caller Token 或数据库
  identity credential；
- Internal 登录必须进入与 OIDC 相同的 `finalizeIdentity()`，创建独立 Principal、
  Realm 和 Identity Session；
- Client Secret 使用 `APP_SECRET_KEY` 的独立 encryption context；
- API 和日志不返回 Secret；
- 变更 issuer、Client ID、Secret 或 protocol parameters 时增加
  `security_revision`；
- Provider Connection 变更后旧 transaction 失效；
- external realm resolution/claim 变更视为 security-sensitive update；
- 已有 Identity Session 是否撤销必须是显式策略，首版建议全部撤销；
- Internal 与 OIDC 中相同 email 的用户不会自动合并；跨 provider linking 不在本阶段。

### 6.2 System UI

只有 admin 能：

- 查看 provider configured 状态；
- 创建或更新配置；
- 运行 provider-specific preflight；
- 启用/停用；
- 轮换 Client Secret；
- 配置允许的 Identity Realms；
- 为 Realm 授予 Project 访问权限；
- 禁用或移除 Realm。

member 不能读取或修改 provider 配置。

### 6.3 Provider 预检

Internal 保存/启用前验证：

- Better Auth verifier 可用；
- Internal Realm key 非空、不可变且在 Connection 内稳定；
- control-plane 登录完成后只能回到注册的 Eveland Identity continuation；
- `session.user.id`、name 和 email 的服务端读取路径；
- Better Auth session 不会直接暴露给 `eve-chats` 或 Agent；
- Identity cookie 与 Better Auth cookie 使用不同 name、secret/context 和过期策略。

OIDC 保存/启用前验证：

- HTTPS issuer；
- Discovery issuer 精确匹配；
- authorization endpoint；
- token endpoint；
- JWKS URI；
- UserInfo endpoint；
- Authorization Code；
- S256 PKCE；
- token endpoint auth method；
- scopes；
- redirect URI；
- 姓名 claim；
- 稳定 External Realm ID 的来源/claim；
- access/refresh token 行为。

不要依据 provider 名称改变协议；金数据特殊参数必须作为显式配置保存。

### 6.4 Provider External Realm 映射

所有 provider adapter 必须把 provider 原生概念规范化为：

```ts
type ResolvedExternalIdentity = {
  externalRealmId: string;
  externalRealmKind:
    | "internal"
    | "account"
    | "corp"
    | "workspace"
    | "enterprise"
    | "tenant"
    | "organization";
  externalSubject: string;
  displayName?: string;
  email?: string;
};
```

`externalRealmKind` 只用于 adapter 元数据、审计和 UI 文案。授权逻辑只使用映射后的
内部 `Identity Realm ID`，不能根据 `account`、`corp`、`workspace` 或 `tenant`
分别实现策略。

| Provider | External Realm ID 来源 | 不能使用 |
| --- | --- | --- |
| Eveland Internal | Connection 上不可变的 Internal Realm key；subject 来自服务端验证后的稳定 `session.user.id` | Organization membership ID、email、name、浏览器提交的 user/realm ID、Better Auth cookie/token 作为 Agent credential |
| 金数据 OIDC | 经验证 ID Token/UserInfo 中的稳定 Account/Organization claim；实际字段必须通过真实预检确认 | Account 名称、email domain |
| 企业微信内部应用 | provider connection 固定的 Corp ID | 企业名称、UserID |
| 企业微信第三方/Suite | 经企业微信验证的授权企业 Corp ID | callback query 中未经验证的值 |
| Slack Workspace | 已验证 ID Token 的 `https://slack.com/team_id` | Workspace 名称、domain |
| Slack Enterprise Grid | 经验证的 `enterprise_id`，必要时再限制 `team_id` | Enterprise 名称 |
| Generic OIDC | tenant-specific issuer，或签名 token/UserInfo 中的稳定 tenant/org claim | email、name、登录提示参数 |

如果 provider 没有能解析为稳定 External Realm ID 的 claim 或 API，则只能：

1. 为每个 Account 使用独立 issuer/client connection；
2. 或在 callback 后调用 provider API 验证 membership。

两者都不可行时必须拒绝该 provider 的多 Account 授权配置，不能退化成公司名或
email domain。

`team`、`login_hint`、`prompt` 等参数只能帮助选择 Account，不构成授权依据。最终
Realm 必须来自经过验证的 provider response。

协议参考：

- OpenID Connect Core：<https://openid.net/specs/openid-connect-core-1_0.html>
- Slack Sign in with Slack：<https://api.slack.com/authentication/sign-in-with-slack>
- Slack team.info：<https://api.slack.com/methods/team.info>
- 企业微信获取 access token：<https://developer.work.weixin.qq.com/document/path/91039>
- 企业微信网页授权身份：<https://developer.work.weixin.qq.com/document/path/91023>

## 7. Identity Realm、Principal 与 Session

### 7.1 数据模型

建议新增：

```text
identity_principals
  id
  identity_realm_id
  external_subject
  display_name
  email
  claims_json（经过允许列表过滤）
  created_at
  updated_at

identity_sessions
  id
  token_hash
  identity_principal_id
  active_identity_realm_id
  expires_at
  last_seen_at
  revoked_at
  created_at

identity_login_transactions
  state_hash
  provider_connection_id
  provider_security_revision
  return_target_id
  return_path
  nonce_hash（OIDC only）
  pkce_verifier_encrypted（OIDC only）
  expires_at
  consumed_at
  created_at

identity_realms
  id
  provider_connection_id
  external_realm_id
  external_realm_kind
  display_name
  enabled
  created_at
  updated_at

identity_realm_project_grants
  identity_realm_id
  project_id
  created_at

identity_oidc_credentials
  identity_principal_id
  provider_connection_id
  access_token_encrypted
  refresh_token_encrypted
  scope
  access_token_expires_at
  rotation_seq
  updated_at

identity_signing_keys
  id
  algorithm
  public_jwk_json
  private_key_encrypted
  status = active | retiring | retired
  not_before
  expires_at
  created_at
```

约束：

- `(provider_connection_id, external_realm_id)` 的 Realm 唯一；
- `(identity_realm_id, external_subject)` 的 Principal 唯一；
- `(identity_realm_id, project_id)` 的 grant 唯一；
- email/name 不能作为 Principal 主键；
- transaction 十分钟或更短；
- state 原子、单次消费；
- Internal continuation 与 OIDC callback 都必须消费同一类 login transaction；
- refresh rotation 有 fencing；
- 同一时间只有一个 active signing key；
- retiring key 在所有已签 token 过期前继续出现在 JWKS；
- token、code 和 Secret 不进入日志或 browser response。

### 7.2 Return target allowlist

不要接受任意 `return_to` URL。

System 中配置允许的聊天 UI origins，例如：

```text
http://localhost:3010
https://chat.example.com
```

登录请求只能携带：

```text
registered target id
relative return path
```

Eveland 根据 allowlist 组装最终 redirect。

### 7.3 登录接口

建议：

```text
GET  /identity/session
GET  /identity/login?target=<id>&returnPath=<relative-path>&switchRealm=<0|1>
GET  /identity/internal/continue
GET  /identity/oidc/callback
POST /identity/logout
```

行为：

- `/identity/session` 只返回安全 profile、内部 active Realm 和 session 状态；
- `/identity/login` 有有效 session 时直接跳回；
- 只有一个 enabled provider 时 `/identity/login` 自动选择；多个 enabled provider 时由
  Eveland 托管选择页或 System 默认策略决定，客户端不能提交任意 issuer/provider URL；
- `switchRealm=1` 时显式轮换/撤销当前 session，并要求 provider 重新选择
  Account/Corp/Workspace；
- 无 Identity Session 时创建 provider-neutral login transaction；
- Internal adapter 有有效 Better Auth session 时直接生成 `ResolvedExternalIdentity`；
- Internal adapter 没有 Better Auth session 时跳现有 Eveland 登录，登录成功后只返回
  `/identity/internal/continue`；continuation 重新服务端验证 Better Auth session，再消费
  transaction；
- Internal adapter 使用不可变 Internal Realm key 和稳定 `session.user.id`，不读取浏览器
  提交的 realm/user/membership/email/name 作为身份依据；
- OIDC adapter 创建 nonce/PKCE 并跳 provider；
- callback 完成 token 验证和 UserInfo 后解析 `external_realm_id`；
- `external_realm_id` 必须精确命中 enabled `identity_realms`；
- 未命中时在创建 Principal/session、持久化 provider credential 之前拒绝登录；
- 两个 adapter 都调用同一个 `finalizeIdentity(ResolvedExternalIdentity, transaction)`；
- finalization 命中 Realm 时 upsert Realm 内 Identity Principal，并创建绑定该 Realm 的
  独立 Identity Session；
- logout 只撤销 Eveland Identity Session，不隐式退出 Better Auth 或金数据，也不要求
  `eve-chats` 清理 provider token。

Account 选择提示不等于授权。即使 login 请求指定了某 Account，callback 仍必须根据
经过验证的 provider response 重新解析并检查 Realm。

`switchRealm=1` 是 Eveland 的 provider-neutral 参数。provider adapter 必须把它转换成
该 provider 支持的 account chooser、prompt 或等价参数；不能由浏览器传入任意
authorization parameters。
provider 不支持可靠切换时应显示明确限制，而不是假装已切换。
Internal provider 的 `switchRealm=1` 不能伪造新的 Realm；它只能使用 Better Auth 明确支持
的 account re-auth/switch，或提示当前 Internal Connection 只有一个 Realm。

这些路由属于独立的 Agent-user identity boundary：

- 必须在现有 control-plane membership middleware 之外显式注册；
- 通用 session/token/JWKS routes 不能要求 Better Auth admin/member session；
- 只有 Internal adapter 的 login/continuation 可以验证 Better Auth session，并且不能
  复用其 cookie 作为 Identity cookie；
- 使用独立 cookie name、session secret/encryption context 和过期策略；
- System provider 配置路由仍然必须经过 control-plane admin authorization；
- 除列出的 login/callback/session/logout/token/JWKS 路径外，不扩大公共 API。

## 8. Eveland Caller Token

### 8.1 Token 目的

Caller Token 是 Eveland 自己签发的短时 JWT：

- 不是 Better Auth session/token；
- 不是金数据 ID Token；
- 不是金数据 access token；
- 不是 control-plane session；
- 只用于调用指定 Eveland Agent。

建议 claims：

```json
{
  "iss": "https://identity.eveland.example.com",
  "sub": "iprn_...",
  "aud": "eveland:project:proj_...",
  "principal_type": "user",
  "realm_id": "irlm_...",
  "name": "陈金洲",
  "email": "user@example.com",
  "iat": 1780000000,
  "nbf": 1780000000,
  "exp": 1780000060,
  "jti": "..."
}
```

首版 TTL 建议 60 秒。

不要把 Better Auth member/session token、金数据 access token、refresh token或完整原始
claims 放入 Caller Token。
也不要包含 provider issuer、provider subject 或 provider 名称；Agent 只应看到 Eveland
内部稳定 Principal ID 和经过允许列表筛选的显示属性。

### 8.2 非对称签名

Eveland Identity 持有私钥；Agent 只能得到公钥/JWKS。

要求：

- 首版使用明确支持的算法，例如 ES256；
- `kid`；
- JWKS endpoint；
- active + retiring key；
- 验证 issuer、audience、exp、nbf、签名；
- token 过期后重新从 Eveland 获取；
- Agent 不能通过公钥伪造身份。

### 8.3 Token endpoint

建议：

```text
POST /identity/caller-tokens
Origin: <allowlisted eve-chats origin>
Cookie: Eveland Identity Session

{
  "projectId": "proj_..."
}
```

响应：

```json
{
  "token": "<short-lived-jwt>",
  "expiresAt": "2026-07-24T12:01:00Z",
  "principal": {
    "id": "iprn_...",
    "name": "陈金洲"
  }
}
```

要求：

- 精确 CORS origin；
- `credentials: true`；
- POST；
- Origin/CSRF 校验；
- project 必须存在且属于当前 Eveland；
- session 必须绑定 enabled active Identity Realm；
- 必须存在 `(active_identity_realm_id, project_id)` grant；
- 没有 grant 时返回 403，不签 token，不触发重新登录；
- token audience 由服务端根据 project ID构造；
- 不接受客户端任意 audience 字符串；
- 返回 `cache-control: no-store`。

未来在这里加入 Realm 内 group/role/allowlist，而不是进入 Agent 逐个配置。

## 9. `evelandIdentity()` Agent AuthFn

建议新增：

```text
packages/agent-identity
```

接口：

```ts
evelandIdentity({
  issuer?: string,
  projectId?: string,
  jwksUrl?: string,
})
```

默认从 Eveland runtime 注入的非 secret 环境读取：

```dotenv
EVELAND_IDENTITY_ISSUER=
EVELAND_IDENTITY_JWKS_URL=
EVELAND_PROJECT_ID=
```

验证成功返回：

```ts
{
  authenticator: "eveland-identity",
  issuer: "<eveland identity issuer>",
  subject: "iprn_...",
  principalId: "<issuer>:iprn_...",
  principalType: "user",
  attributes: {
    realmId: "irlm_...",
    name: "陈金洲",
    email: "..."
  }
}
```

不要直接使用当前 Eve `jwtEcdsa()` 作为最终实现，因为当前 helper 建立的是
`principalType: "service"`；`evelandIdentity()` 必须明确建立 user principal，
以支持用户级 instructions、skills、tools 和 connection auth。

`realm_id` 必须投影成内部 `attributes.realmId`。Agent 的 Realm-scoped 数据、
memory、tools 和 connection credentials 使用该内部 ID 隔离，不使用外部 Account/Corp/
Workspace ID。

验证失败返回 `null` 以允许下一个显式 AuthFn；provider/JWKS 暂时不可用时应
fail closed 并返回安全的 401/503 策略，具体行为用测试固定。

### 9.1 Helper 分发不能依赖本机相邻目录

Eveland 导入的 Agent 会生成独立 source snapshot，并在隔离构建环境安装依赖。
因此首个 Agent 不能长期使用：

```text
file:../eveland/packages/agent-identity
```

该路径不会可靠地进入 source snapshot，也违反构建隔离假设。

第一阶段验证可以先在 greeter 内放一个极小的、测试覆盖的 AuthFn：

```text
agent/lib/eveland-identity.ts
```

它使用 Eve 的 token/JWKS verifier，再显式投影为
`principalType: "user"`。纵向链路验证通过后，必须在推广前选择一种正式分发方式：

1. 发布版本化的 `@eveland/agent-identity` 包；
2. 或设计并审查 Eveland release-time identity hook。

第二种方式会改变 Agent 入站安全边界，不能顺手扩展现有 observer 注入；需要单独的
产品 contract、回滚策略和安全测试。

在正式分发方式落定前，只能称为首个 Agent pilot，不能宣称所有已有 Agent 已自动支持。

## 10. Gateway 边界

保持现有原则：

- Public Agent Host 继续由 Agent 自己认证；
- Gateway 不成为金数据 OIDC Client；
- Gateway 不验证或转发 Better Auth session/token 给 Agent；
- Gateway 不保存 Identity Session；
- Gateway 不接收 Client Secret；
- Gateway 不把公开请求改成 localhost identity；
- Gateway 删除外部伪造的保留 `X-Eveland-*`；
- `Authorization: Bearer <Eveland Caller Token>` 作为 Agent-owned credential
  透明转发；
- request/response streaming 和 abort propagation 不变。

## 11. `eve-chats` 集成

### 11.1 Agent catalog

每个 Eveland Agent 连接需要一个非 secret platform identity：

```text
evelandProjectId
```

它用于向 Eveland申请正确 audience 的 Caller Token。

这不是逐 Agent OIDC 配置，不包含 issuer、Client ID 或 Secret。

如果 catalog 未来直接来自 Eveland API，project ID 可由 catalog 自动提供；首版可给
现有 `agent_connections` 增加 nullable `eveland_project_id`。

### 11.2 点击 Agent

建议前端流程：

1. 调用 Eveland `/identity/session`，携带 credentials；
2. 若未登录，top-level redirect 到：

   ```text
   /identity/login?target=eve-chats&returnPath=/agents/<id>
   ```

3. 回到同一 Agent 页面后再次读取 identity session；
4. 显示当前 Principal 的安全 profile 和 active Identity Realm；
5. POST `/identity/caller-tokens`，请求目标 project；
6. 有 Realm → Project grant 时返回 token；
7. 403 时展示“当前身份范围无权使用此 Agent”，不自动重登；
8. token 只保存在浏览器内存；
9. 创建/继续/stream 前如果 token 即将过期，重新申请；
10. 第二个 Agent 请求新的 project-bound token，Eveland session 自动复用。

`eve-chats` 不实现 Internal/金数据选择，也不读取 Better Auth session。它只进入
Eveland 的通用 login endpoint；Internal 登录、OIDC 登录和多 provider 选择全部由
Eveland Identity 托管。

UI 提供显式“切换身份范围”入口；也可以根据 provider 显示“切换 Account”或
“切换 Workspace”。切换时重新进入 Eveland login，并设置 `switchRealm=1`；
callback 必须重新验证 External Realm ID。不得通过修改前端 Account ID 或 Project ID
完成切换。

### 11.3 Chat ownership

`eve-chats` 仍需防止用户访问他人的 chat。

因为它不持有 Identity Session，所以每个 chat API 请求必须携带当前 Caller Token。
`eve-chats` 使用 Eveland JWKS 验证 token，并读取：

```text
iss
sub
aud
realm_id
exp
```

数据库给 `chats` 增加：

```text
owner_identity_principal_id
owner_identity_realm_id
eveland_project_id
```

要求：

- 新 chat 的 `owner_identity_principal_id` = 已验证 Caller Token 的 `sub`；
- chat Realm = 已验证 Caller Token 的内部 `realm_id`；
- project ID 与 token audience 一致；
- list/get/message/event/proxy/stream 全部校验 owner、Realm 和 project；
- 同一自然人在不同 Account 下的 chat 不能互相访问；
- 访问他人的 chat 返回 404；
- token 不落库；
- owner-null 旧聊天不自动暴露；
- `eve-chats` 只信任配置的 Eveland issuer/JWKS，不信任浏览器传来的 name。

这里 `eve-chats` 知道的是通用 Eveland identity contract，不是金数据。

### 11.4 Proxy

浏览器把短时 Caller Token发给 `eve-chats` 同源 proxy。Proxy：

1. 验证 token；
2. 校验 chat owner、Identity Realm 和 project audience；
3. 从请求中移除用户可控的其他 Agent auth headers；
4. 将同一个 token 作为上游 `Authorization: Bearer`；
5. create、continue、stream、cancel 都执行相同检查；
6. 不把 token 写入 log、event、message、session JSON 或 error body。

如果 token 在 stream 建立前过期，返回结构化 `caller_token_expired`，浏览器重新申请并
重连。stream 已开始后不做透明重放。

### 11.5 浏览器与 Cookie 拓扑

为了复用 Eveland Identity cookie：

- Eveland Identity API 必须允许精确的 `eve-chats` origin；
- 浏览器请求使用 `credentials: "include"`；
- 本地不同端口使用同一 hostname；
- 生产优先部署在同一 site 的不同 origin；
- 不依赖第三方 Cookie；
- 非同站部署需要明确验证浏览器策略，不能假设跨站 cookie 可用。

## 12. 首个验证 Agent

使用：

```text
/Users/michael/work/eve-wecom-greeter
```

首个验证 Agent 复用：

- 简单聊天能力；
- `agent/instructions/caller.ts`；
- `buildCallerInstructions()`。

动态 instructions 已读取：

```ts
ctx.session.auth.current
```

因此只需确认 `evelandIdentity()` 提供 `attributes.name`。

## 13. 与现有 Eveland 规范的关系

这是有意扩展产品 contract，不应只改代码。

当前规范明确：

- control-plane member ID 不发送给 Agent；
- Gateway 不替 Agent 做身份提供方；
- Agent Connection OIDC 是 Playground delegated credential；
- Agent verifier 与 Eveland credential provider 必须分离。

新设计保持前三个安全边界，但增加一套独立的 Agent-user Identity：

```text
Control-plane Auth
  ≠ Agent-user Identity
  ≠ Playground Agent Connection credential
```

必须同步更新：

- `docs/spec.md`；
- `README.md`；
- `docs/deploy/linux.md`；
- `.env.example`；
- Compose env；
- 当前 Gateway/Agent Auth handoff notes；
- System 设置文档。

不要默默把现有 Playground OIDC callback 改造成 Identity callback；两者是独立产品能力。

## 14. 分阶段测试驱动实施

### Phase 0：现状与边界 Spike

先写最小设计测试/探针：

1. 定位现有 Better Auth session verifier、登录入口和安全的 relative continuation；
2. 证明 Internal adapter 只能服务端读取 `session.user.id`/name/email；
3. 证明 Better Auth cookie 与新 Identity cookie 的 name、secret/context 和用途分离；
4. 定义 provider-neutral `ResolvedExternalIdentity` 和 `finalizeIdentity()` contract；
5. 中央 Identity Session cookie 绑定 active Realm；
6. Caller Token ES256 签发/JWKS 验证；
7. token audience 绑定 project；
8. `realm_id` 绑定内部 Identity Realm；
9. `evelandIdentity()` 返回 user principal；
10. 浏览器跨 origin session/token 请求可行。

如果浏览器 cookie 拓扑不可行，停止并选择：

- 同站部署；
- 或 generic authorization-code handoff 给 `eve-chats`。

Phase 0 不接金数据，不让 Agent 或 `eve-chats` 直接接受 Better Auth credential。

### Phase 1：Contracts 与数据库

先写 PGlite Store 测试：

- `internal | oidc` Provider Connection 配置、type-specific validation 和 security revision；
- Realm `(Provider Connection, External Realm ID)` 唯一；
- Principal `(Realm, External Subject)` 唯一；
- Realm → Project grant 唯一和级联行为；
- session hash、active Realm、过期、撤销；
- provider-neutral login transaction 原子消费和过期清理；
- OIDC credential 加密、refresh rotation fencing；
- signing key rotation；
- return target allowlist；
- Provider Connection 变更撤销旧状态。

然后更新 schema、repositories、mappers、store domains 和新 migration。

### Phase 2：System Identity Provider 与 Internal 配置

API/UI 测试：

- admin 可创建 `Eveland Internal` Connection；
- member 403；
- Internal Realm key 创建后不可变；
- Internal preflight 能验证 Better Auth verifier/continuation；
- enable/disable；
- 第一阶段只允许一个 enabled Internal provider；
- Identity Realm allowlist；
- Realm → Project grants；
- 未知/重复 External Realm ID 拒绝；
- security-sensitive update 增 revision；
- UI/API 不暴露 Better Auth session/member credential。

### Phase 3：Internal Identity 登录

使用现有 Better Auth 测试 session：

- login URL；
- 无 Better Auth session → 现有 Eveland login；
- Better Auth 登录后只回 `/identity/internal/continue`；
- continuation 重新服务端验证 session；
- 有 Better Auth session → 不重复登录；
- Internal Realm key + stable `session.user.id` → `ResolvedExternalIdentity`；
- 浏览器提交的 user/membership/realm/email/name 被忽略或拒绝；
- 调用公共 `finalizeIdentity()`；
- state replay/expiry；
- enabled Realm 精确匹配；
- 未允许 Internal Realm 不创建 Principal/session；
- session 绑定 active Realm；
- profile allowlist；
- Identity cookie 与 Better Auth cookie 完全独立；
- existing session 直接 return；
- logout；
- provider timeout/error 安全映射；
- 无 Better Auth cookie/session token 日志或响应泄漏。

### Phase 4：Caller Token

测试：

- 有效 session 才能签发；
- project 必须存在；
- issuer/audience/TTL/jti；
- name/email/internal Realm ID projection；
- 非对称签名和 JWKS；
- disabled Provider Connection/session revoked 拒绝；
- disabled Realm 拒绝；
- 缺少 Realm → Project grant 返回 403；
- 有 grant 才签发；
- exact CORS origin 和 CSRF；
- unauthorized project policy；
- key rotation；
- no-store。

### Phase 5：`evelandIdentity()`

测试：

- valid token → user principal；
- wrong issuer/audience/signature/kid；
- expired/not-yet-valid；
- missing sub/name；
- project mismatch；
- Realm ID 缺失/非法；
- `realmId` attributes projection；
- JWKS unavailable fail closed；
- auth walk 可继续到 `vercelOidc()` / `localDev()`；
- 不接受 Better Auth session/token；
- 不接受金数据 token；
- pilot 的 colocated AuthFn 在隔离 Agent build 中可用；
- 不使用指向 Eveland workspace 的外部 `file:` dependency。

### Phase 6：`eve-chats`

测试：

- 未登录点击 Agent → Eveland login；
- `eve-chats` 不读取 Better Auth session，不指定 provider；
- 已有 Identity Session 不再触发 provider 登录；
- 同一 Realm 有 grant 的第二个 Agent 重用中央 session；
- 无 grant 的第二个 Agent 返回 403；
- 显式切换身份范围重新进入 Eveland provider 流程；
- 切换后 active Realm 和 session 轮换；
- token 仅在内存；
- token过期重新申请；
- chat owner/Realm/project audience；
- 用户间 chat 隔离；
- 同一自然人跨 Account chat 隔离；
- create/continue/stream/cancel 统一转发；
- token 不持久化、不记录；
- provider 对 `eve-chats` 完全不可见；
- 旧 `bearer/header` connection auth 与 Caller Token 冲突时明确拒绝。

### Phase 7：Internal Provider 纵向集成里程碑

真实 Internal provider：

```text
click Agent
  → Eveland login
  → Better Auth（必要时）
  → Internal continuation
  → verified Better Auth user → ResolvedExternalIdentity
  → active Identity Realm Session
  → Realm → Project grant
  → project-bound Caller Token
  → eve-chats proxy
  → Gateway
  → evelandIdentity()
  → ctx.session.auth.current
  → Hello, 测试用户。
```

再验证：

- 同一 Realm 被授权的第二个 Agent 不触发 Better Auth/Internal 登录；
- 未授权 Project 返回 403；
- 未允许 Internal Realm 无法建立 session；
- Better Auth credential 从未到达 `eve-chats`、Gateway 或 Agent；
- logout 后不能申请新 Caller Token；
- 另一 member 无法读取前一 member 的 chat。

**这是第一个必须独立验收的交付点。Internal 纵向链路未通过前，不开始金数据实现。**

### Phase 8：通用 OIDC Adapter

在不改 Phase 4–7 下游 contract 的前提下，使用 fake OIDC provider 测试：

- OIDC Connection API/UI、Secret 不返回；
- Discovery preflight；
- invalid issuer/scope/redirect 拒绝；
- Authorization Code + state/nonce/PKCE；
- callback success、replay/expiry；
- issuer、audience、nonce、signature、exp；
- UserInfo sub 一致；
- 从 verified claims/UserInfo 解析 External Realm ID；
- provider Account selection hint 与 verified External Realm ID 不一致时以后者为准；
- enabled Realm 精确匹配；
- 未允许 Account 不创建 Principal/session、不持久化 credential；
- OIDC adapter 调用与 Internal 相同的 `finalizeIdentity()`；
- access/refresh credential 加密和 rotation fencing；
- provider timeout/error 安全映射；
- 无 token/code/Secret 日志；
- Internal 与 OIDC 都 enabled 时，Eveland 托管 provider selector/default policy；
- `eve-chats` 接口和行为不变；
- 相同 email 的跨 provider Principal 不自动合并。

### Phase 9：金数据 OIDC

先做真实协议 preflight：

1. 金数据 Discovery；
2. Authorization Code + PKCE；
3. callback 只落 Eveland；
4. 确认真实 Account claim 及其稳定性；
5. allowed Account 能映射 Realm；
6. 未允许 Account 在 Principal/session/credential 创建前拒绝。

然后把金数据作为 `type=oidc` Connection 配置，不增加 Jinshuju-specific Agent、
Gateway 或 `eve-chats` 代码。金数据特殊参数只能作为显式 Connection 配置。

## 15. 手工验收

### 15.1 Internal Provider 验收

1. admin 在 Eveland System 创建并启用 `Eveland Internal`；
2. 创建 enabled Internal Identity Realm；
3. 给该 Realm 授予 greeter Project 和第二个测试 Project；
4. 保留第三个 Project 无 grant；
5. 配置 allowlisted `eve-chats` origin；
6. 启动含 `evelandIdentity()` 的 greeter；
7. 在 `eve-chats` 注册 greeter 和其 Eveland project ID；
8. 清除 Eveland Identity cookie；
9. 点击 greeter；
10. 未登录 Better Auth 时，确认先完成 Eveland 登录，再回原 Agent 页面；
11. 已登录 Better Auth 时，确认 Internal adapter 直接建立独立 Identity Session；
12. 发送 `hello`；
13. 确认：

    ```text
    Hello, 陈金洲。
    ```

14. 确认 Agent 收到内部 `realmId`；
15. 打开有 grant 的第二个 Agent，确认不再登录且收到相同
    `principalId/realmId/name`；
16. 打开无 grant 的第三个 Agent，确认 403；
17. logout，确认不能申请新 Caller Token；
18. 用另一 Better Auth member 登录，确认无法读取前一用户 chat；
19. 检查浏览器请求、日志、数据库和事件：Better Auth credential 未到达
    `eve-chats`/Gateway/Agent，Caller Token 没有明文持久化。

### 15.2 金数据 OIDC 验收

1. admin 在 Eveland System 新增金数据 OIDC；
2. preflight 成功并确认真实 Account stable ID claim；
3. 只创建指定 Account 的 enabled Identity Realm；
4. 给 Realm 配置 Project grants；
5. 清除 Eveland Identity cookie，从 Eveland provider selector 选择金数据；
6. 确认跳转金数据，callback URL 属于 Eveland；
7. 选择 allowed Account，确认回到原 Agent 页面；
8. 发送 `hello`，确认 Agent 收到金数据映射后的独立 `principalId/realmId/name`；
9. 打开有 grant 的第二个 Agent，确认不再出现外部登录；
10. 打开无 grant 的 Project，确认 403；
11. 显式切换到未允许 Account，确认 callback 拒绝且不建立 session；
12. 如果配置第二个 allowed Account，切换后确认获得不同内部 Realm；
13. 确认两个 Realm 的 chat 不可互访；
14. 确认 Internal 与金数据相同 email 不会自动合并 Principal；
15. 检查浏览器、日志、数据库和事件，没有金数据 token 或 Caller Token 明文持久化。

## 16. 验收标准

- Eveland Internal 是第一个可工作的 provider；
- Internal 只把服务端验证后的 Better Auth member 映射为独立 Identity Principal/Realm；
- Better Auth session/token 不是 Identity Session、Caller Token 或 Agent credential；
- Internal 与 OIDC 共用 `ResolvedExternalIdentity` 和 `finalizeIdentity()`；
- Internal 闭环通过后才实现并启用金数据；
- 金数据配置只存在于 Eveland System；
- 金数据 callback 只存在于 Eveland；
- Identity Session 只存在于 Eveland；
- 未允许的外部 Account/Corp/Workspace 无法建立 Identity Session；
- session 绑定一个 active Identity Realm；
- Identity Realm 使用稳定 External Realm ID，不使用名称/email domain；
- Caller Token 只有在 Realm → Project grant 存在时才签发；
- `eve-chats` 没有金数据依赖；
- `eve-chats` 不知道或读取 Better Auth credential；
- Agent 没有金数据依赖；
- Agent 不接受 Better Auth credential；
- Gateway 没有金数据 Secret；
- 第二个 Agent 重用 Eveland session；
- Caller Token 短时、非对称签名、project audience-bound；
- Caller Token 不包含 provider issuer、provider subject 或 provider 名称；
- 不同 Provider Connection 的相同 email 不自动合并 Principal；
- Agent 通过 `evelandIdentity()` 把 Identity Principal 投影成 Eve user principal；
- `ctx.session.auth.current.attributes.name` 可用；
- `ctx.session.auth.current.attributes.realmId` 是内部 Realm ID；
- chat owner、Realm 和 project 三重隔离；
- public Gateway auth transparency 不回归；
- control-plane member 与 Agent-user identity 不混用；
- Agent connection Playground OIDC 不被改写；
- 所有实现和运维文档同步更新。

## 17. 本阶段不做

- Internal/金数据以外的企业微信、飞书、Slack provider；
- Internal 与金数据之间的自动 account linking/federation；
- 允许浏览器提交任意 issuer、provider URL、user/membership ID 或 Realm ID；
- 自动把任意 existing Agent 源码改成 `evelandIdentity()`；
- Realm → Project grant 之外的细粒度 groups/roles policy；
- 跨 Realm identity federation；
- token exchange 标准化；
- 把整个 `eve-chats` 聊天存储搬进 Eveland；
- npm 发布、commit、push 或 PR。

首版授权策略：

```text
只有 enabled Identity Realm
  且存在显式 Realm → Project grant
  → 才能为该 Project 获取 Caller Token
```

不提供“所有登录用户访问所有 Agent”的隐式 fallback。System UI 必须明确显示每个
Realm 当前授权的 Projects。

## 18. 验证命令

按实际改动运行 focused tests，然后至少：

### Eveland

```bash
cd /Users/michael/work/eveland
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
```

数据库变化还需：

```bash
pnpm --filter @eveland/db db:generate
pnpm --filter @eveland/api db:migrate
```

Web 变化：

```bash
pnpm --filter @eveland/web build
```

Compose/env 变化必须验证 merged Compose 配置。

### `eve-chats`

```bash
cd /Users/michael/work/eve-chats
corepack pnpm db:up
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
git status --short
```

### 首个 Agent

```bash
cd /Users/michael/work/eve-wecom-greeter
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
git status --short
```

交接时准确报告哪些命令实际运行、哪些没有运行。

## 19. 当前工作区注意事项

写入本计划前：

```text
/Users/michael/work/eve-chats
  branch: main
  .plans 尚未跟踪

/Users/michael/work/eve-wecom-greeter
  branch: main
  no commits
  demo 文件全部未跟踪
```

未经用户明确要求：

- 不清理未提交文件；
- 不 commit；
- 不 push；
- 不发布 package；
- 不创建 PR。

## 20. 新会话启动语

> 请打开并执行
> `/Users/michael/work/eve-chats/.plans/2026-07-24-jinshuju-oidc-authenticated-web-chat-handoff.md`。
> 开始前完整阅读 Eveland 的 `AGENTS.md`、`docs/spec.md`、`README.md`、Linux deployment 文档和
> Agent Auth/Gateway handoff；检查 Eveland、eve-chats、greeter 三个仓库的 git status，
> 保留所有已有改动。从 Phase 0 开始，严格测试先行。先完成 Phase 0–7，以
> `Eveland Internal` 作为第一个 provider 打通并独立验收完整纵向链路；Internal adapter
> 只能服务端验证现有 Better Auth session，并把稳定 `session.user.id` 显式映射为独立
> Identity Principal/Realm，必须创建独立 Identity Session，不能把 Better Auth cookie、
> session token 或 control-plane member principal 直接交给 eve-chats、Gateway 或 Agent。
> Internal 与后续 OIDC adapter 必须产出同一个 `ResolvedExternalIdentity` 并进入同一个
> `finalizeIdentity()`。Phase 7 未通过前不要开始金数据；通过后再执行 Phase 8–9，把金数据
> OIDC 作为第二个 provider，callback 只在 Eveland，并从 verified provider response 解析
> 稳定 External Realm ID。所有 provider 都只有在精确命中 enabled Identity Realm 且存在
> 显式 Realm → Project grant 时，才能签发短时、project-bound Caller Token。
> eve-chats 保持 provider-neutral、不保存身份状态，只转发当前 token 并执行 chat ownership；
> Agent 只使用 provider-neutral 的 `evelandIdentity()`，并从内部 `realmId` 做 Realm 隔离。
> 不要使用名称或 email domain 做身份主键/授权，不要自动合并跨 provider 的相同 email，
> 不要改写 Playground Agent Connection OIDC，不要 commit/push/publish，除非我明确要求。

## 21. Phase 0–7 收口记录（2026-07-27）

Internal Provider 纵向里程碑完成后，追加以下收口，不开始 Phase 8–9：

- Native development 在旧 `.env` 缺少 Identity 配置时使用明确的 localhost
  默认值；production 仍必须显式配置；
- API 与 Worker dev watcher 监听共享 `.env`；
- Worker 持久化 issuer/JWKS 配置指纹，变化时为 live Deployment 排入一次定向
  restart，避免运行中的 Agent 继续使用旧 verifier 配置；
- 新增可独立 build、pack 的 `@eveland/agent-identity` 包，Eve 使用 peer
  dependency；包测试覆盖 project audience、内部 Principal/Realm ID、时间窗口、
  JWKS 故障/轮换和显式 auth fallback；
- 按本计划“不发布 npm 包”的约束，pilot greeter 暂时继续使用测试覆盖的 colocated
  AuthFn；推广到其他 Agent 前再发布已验证的版本化包；
- `eve-chats` 对同一 Project 的并发 Caller Token 请求执行 single-flight，仍只在
  内存缓存并在过期前刷新；
- Agent 入口和已有聊天页的 transient Identity failure 都提供显式 Retry；
- Principal + Realm + Project 三重隔离、Realm → Project grant、Caller Token
  转发和 Deployment restart 路径继续由现有集成测试覆盖。
