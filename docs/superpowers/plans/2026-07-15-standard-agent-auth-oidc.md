# EveChats 标准 Agent Auth：需求梳理与架构设计

设计日期：2026-07-15（v6。v2 凭证隔离键/获取方式建模/动态接口；v3 作用域/接口收窄/resolver 桥接/refresh subject/预检；v4 取消第一等 stream()/刷新租约/`prompt=consent`/AccessTokenVerifier；v5 交互上下文/结构化请求目标/传输 adapter/fencing/版本化 401；v6 connection 安全版本、provider 交互描述、第二次 401 终态、refresh token response 激活、出站安全策略与验收矩阵）
依据：[Eve Auth & Route Protection 官方文档](https://eve.dev/docs/guides/auth-and-route-protection) 及研究文档 [eve-auth-and-route-protection.md](../../research/eve-auth-and-route-protection.md)；关键库行为已对照 `eve@0.24.3` 源码验证（见 B9 表注）

---

## Part A · 需求梳理

### A1. 问题定义

EveChats 是通用 Eve Agent 客户端，要能连接**任意已有获取方式适配**的 Eve Agent。Eve 官方把认证分为两个独立系统，EveChats 的角色在其中必须先划清楚：

| Eve 的系统 | 方向 | EveChats 的角色 |
| --- | --- | --- |
| Route auth | 调用方 → Agent 的 `/eve/v1/*` | **EveChats 是调用方**，必须携带 Agent 认可的凭证 —— 本设计的全部范围 |
| Connection OAuth | Agent → 外部服务（MCP/API） | Agent 自己的事；EveChats 只需在事件流里渲染 `authorization.required` challenge，不参与凭证 |
| EveChats 自身登录 | 用户 → EveChats | 独立的未来需求，只作为"caller principal"维度预留 |

所以核心问题是：**为任意 Agent 声明的任意 route auth 策略，提供一个统一的"出站调用凭证"模型。**

### A2. 必须覆盖的 Agent 侧策略全景

Agent 端 `eveChannel({ auth })` 可用的策略，以及 EveChats 作为调用方分别需要什么：

| Agent 侧策略 | 线上传输形态 | 凭证从哪来 | 生命周期 |
| --- | --- | --- | --- |
| `none()` / `localDev()` | 无凭证 | 不需要 | 无 |
| `httpBasic()` | `Authorization: Basic` | 用户配置（静态） | 不过期 |
| `jwtHmac()` / `jwtEcdsa()` | `Authorization: Bearer` | 用户粘贴已签发的 JWT（静态） | 可能有 `exp`，过期只能换新的 |
| `oidc()` | `Authorization: Bearer` | **verifier 不规定获取方式**：Authorization Code（交互）、Client Credentials（机器）、Token Exchange、静态粘贴均可产出它能验的 bearer | 取决于获取方式 |
| `vercelOidc()` | Bearer + Vercel trusted header（双 header） | 机器签发：运行环境 token resolver | 自动续期 |
| 自定义 `AuthFn` | 任意机制 | header 形态可静态配置；mTLS、SigV4、DPoP 等形态需未来专门的获取方式 | 由 Agent 约定 |

三个结构性事实决定架构分层：

1. **传输形态收敛**：所有策略在线上只有几种形态——无、Basic、Bearer、自定义 headers（外加 Vercel 双 header variant）。这是 Eve `ClientAuth` 的线格式契约，本设计的传输层严格对齐它。
2. **凭证解析必须是每请求的**：token 会轮换，流式重连是新请求；任何"创建时固化凭证"的封装都会让重连用旧 token。
3. **真正的差异在获取与生命周期**：静态粘贴、交互式登录、机器签发，三类来源的配置方式、过期行为、401 恢复策略、**归属主体**完全不同。**服务端 verifier 名称（如 `oidc()`）不等于获取方式**，同一 verifier 可对应多种获取方式。

### A3. 用户故事

- **U1 公开 Agent**：添加 `none` 的 Agent，直接聊天。
- **U2 API key Agent**：Agent 用自定义 `AuthFn` 验 `x-api-key`；用户配置 header 名和值。
- **U3 静态 JWT Agent**：Agent 用 `jwtHmac`/`jwtEcdsa`；用户粘贴一个签好的 token。
- **U4 Basic Agent**：用户配置用户名/密码。
- **U5 OIDC 交互式 Agent（首个交互式场景）**：Agent 用 `oidc({ issuer, audiences })`，用户选择 `oidc-authorization-code` 获取方式；第一次发消息被引导到 IdP 登录，之后 token 自动刷新，聊天与 stream 重连全程无感；refresh 永久失效时被引导重新登录。
- **U6 机器凭证 Agent（后续）**：同样的 `oidc()` Agent 面向服务调用时，用 `oidc-client-credentials`（凭证归属 connection，不随浏览器用户重复签发）；Vercel 部署用 `vercel-oidc`。
- **U7 凭证中途失效**：任何获取方式下游返回 401，用户看到统一的结构化反馈，可交互的给出行动入口；403 一律不尝试恢复。
- **U8 探活分层**：用户能区分"Agent 不可达"（liveness）、"凭证无效"（auth readiness）、"会话不可用"（chat readiness）三种故障。

### A4. 需求清单

**功能性**

- F1 每个 Agent connection **显式声明**获取方式（auth method）+ 该方式的配置（不同 Agent 可用不同方式、不同 IdP）。
- F2 静态凭证：配置一次，永久注入；错误时给出明确配置级报错。
- F3 交互式凭证（OIDC Authorization Code）：授权流程、令牌存储、静默刷新、重新授权引导。
- F4 所有**受保护**的出站调用（session 创建/继续/stream、`/eve/v1/info`）走同一凭证注入路径，凭证在**每次请求时**动态解析；流式调用的每次重连是一次新的受保护请求，天然经过凭证解析与 401 恢复；`GET /eve/v1/health` 官方规定永远公开，**匿名访问、不进认证管道**。
- F5 401 恢复语义按获取方式决定，对同一请求**最多恢复一次**；第二次 401 仍通知 provider 做终态归一化，但不发起第三次请求：版本未变才作废，版本已变化则保留新版并返回 `retry_required`。403 永不触发刷新或重试。
- F6 前端只面对**一种**结构化认证错误契约（领域错误码 + 可选 interaction），不感知获取方式细节。
- F7 凭证按获取方式的归属主体隔离：**委托型**按 `(agent connection, caller principal)`；**机器型/静态**按 `agent connection`。任何跨 connection 复用必须显式建模，不允许通过键碰撞隐式发生。
- F8 探活三层：liveness（匿名 `/health`）、auth readiness（带凭证 `/info`）、chat readiness（真实 session 路径）。
- F9 状态查询严格只读（不刷新、不调 IdP）；交互式授权入口需要 chat 上下文时，由调用方显式提供、模块拼装、授权路由最终校验。
- F10 凭证与授权事务必须绑定 connection 的**安全版本**；Agent URL、auth method 或 auth config 改变后，旧版本凭证与在途 callback 永不重新激活，也不得与新 URL/配置混用。

**非功能性**

- N1 标准优先：OIDC/OAuth 严格走 RFC 与当前安全 BCP（RFC 9700 / OAuth 2.1 方向），协议实现复用 certified 库（`openid-client`）；传输层严格对齐 Eve `ClientAuth` **线格式契约**（对照 `eve@0.24.3` 源码验证），token 校验复用 Eve 公开的 `verifyOidc`。
- N2 凭证服务端托管：secret 与 token 加密落库，永不下发浏览器（注：这消除的是"脚本直接窃取 token"的面；XSS 仍可借用户会话代发请求，会话本身仍需常规防护）。
- N3 可扩展：新增一种获取方式 = 新增一个 provider 模块（+ 可选交互路由 + 配置表单描述），聊天 proxy、stream、session 恢复主流程零改动。
- N4 fail closed：配置缺失/解密失败/凭证不可得时拒绝出站调用并结构化报错，而不是裸连。
- N5 并发安全：**刷新权在调用 IdP 之前取得**且带 fencing（租约 id + 版本校验），正常并发下任一时刻至多一个执行体调用 token endpoint（崩溃/网络不确定场景存在不可消除窗口，见 B5）；交互式授权支持多标签页并发。
- N6 出站安全：Agent URL、OIDC issuer/discovery/JWKS 与请求 pathname 统一经过 URL/SSRF policy；生产环境网络层同时阻断 loopback、link-local、云 metadata 与未授权私网出口，不能只依赖应用层的单次 DNS 检查。

**明确的非需求**

- 不做 auth 自动发现：默认 `WWW-Authenticate` 只有 Basic/Bearer 粒度，custom `AuthFn` 更是任意形状；challenge 只能当提示，获取方式必须显式配置。
- 不承诺覆盖 custom `AuthFn` 的全部形态：mTLS、SigV4、DPoP 等需要未来专门的获取方式与传输扩展，`headers` 只覆盖其 header 形态。
- 不实现 Eve connection OAuth 客户端。
- 不在本设计内实现 EveChats 用户体系（只预留 principal 维度）。

---

## Part B · 架构设计

### B1. 总览：一个深模块 + 内部三层

```
                    proxy / health check / status API
                                │  只依赖 ↓
┌────────────────────────────────────────────────────────────────┐
│                    AgentAuthModule（对外唯一接口）                │
│   request() · status()  —— 仅此两个方法                          │
│   配置加载/解密/校验、安全版本绑定、凭证获取、401 单次恢复（带版本）、│
│   错误归一化、交互 URL 拼装 —— 全部内化                           │
├────────────────────────────────────────────────────────────────┤
│ L0  AuthMethod 目录（声明层）                                    │
│     服务端注册表：schema + provider + scope + interaction 描述    │
│     客户端表单描述：可序列化字段元数据（与注册表分离下发）           │
├────────────────────────────────────────────────────────────────┤
│ L1  CredentialProvider（获取/生命周期层，模块内部 adapter seam）  │
│     getCredential / inspect / recoverUnauthorized（终态重载）      │
│     ├─ static 族：none · basic · bearer · headers（connection）  │
│     ├─ interactive 族：oidc-authorization-code（principal）      │
│     └─ machine 族：oidc-client-credentials · vercel-oidc         │
│        （connection，未来）                                      │
├────────────────────────────────────────────────────────────────┤
│ L2  传输 adapter（模块私有，自持 fetch）                          │
│     结构化目标 → 标准 URL API 构造地址；                          │
│     凭证 → header 物化（对齐 ClientAuth 线格式），每请求解析、      │
│     最后写入保证不被业务 header 覆盖；redirect: manual；URL policy │
└────────────────────────────────────────────────────────────────┘
```

要点：

- **proxy 只递 id**（+ 可选交互上下文）。模块内部完成 connection 加载、配置解密与校验；connection 快照与凭证必须按同一 `securityRevision` 读取，确保只会出现“旧 URL + 旧凭证”或“新 URL + 新凭证”，绝不混搭。
- **传输 adapter 自己构造 URL、自己执行 fetch**。经 `eve@0.24.3` 源码验证的两个事实使复用 `Client.fetch` 不可行：① 绝对 host 下 path 被赋给 `URL.pathname`，query 的 `?` 被百分号编码，且 `createClientUrl` 的 `searchParams` 参数未被 `Client.fetch` 暴露——流式重连的 `startIndex` 无法传递；② header 合并顺序为 options.headers → init.headers → auth，`init.headers` 会覆盖 options.headers，即业务 header 可覆盖 `headers` 类凭证。adapter 复用的是 ClientAuth 的**线格式契约**（Bearer trim、Basic 编码、vercelOidc 双 header），不是它的封装。
- **获取方式（auth method）≠ 服务端 verifier 名**；每个获取方式声明自己的凭证作用域（`credentialScope`）。
- OIDC 只是 L1 的一个 provider，它的 token 只是通用凭证存储里的一种 payload。

### B2. 核心类型（契约）

**模块对外接口（proxy 唯一依赖）：**

```ts
type AgentAuthTarget = { agentConnectionId: string; principalId: string };  // 凭证归属

type AgentRequestTarget = {
  pathname: string;                          // 如 "/eve/v1/session/:id/stream"
  searchParams?: Record<string, string>;     // 如 { startIndex: "7" } —— 不允许拼进 pathname
};

type AgentRequestInit = {
  method?: "GET" | "POST";
  jsonBody?: unknown;                        // 模块序列化并设置 content-type；
                                             // 可重放由构造保证（401 重试安全）
  signal?: AbortSignal;
};                                           // 不接受任意 headers / body 流 / 认证相关字段

type InteractionContext = { chatId: string };  // returnTo 由服务端从 chatId 推导（允许列表），
                                               // 不接受调用方任意传入

type AuthInteraction = { type: "redirect"; url: string };
// url 为同源相对路径：provider 只声明路由基址，模块拼装上下文参数并校验

type AgentAuthFailure = {
  code: "interaction_required" | "credential_rejected" | "forbidden"
      | "configuration_invalid" | "provider_unavailable" | "upstream_unavailable"
      | "retry_required";
  method: string;                            // 由模块盖章，与 B7 响应形状一致
  message: string;
  interaction?: AuthInteraction;
};

interface AgentAuthModule {
  /** 受保护调用的唯一入口（turn、/eve/v1/info、流式路由）。
      内部：加载配置 → 取凭证 → 传输 adapter 发起 → 401 带版本恢复一次 → 错误归一化。
      流式路由返回原始流式 Response：401 发生在响应头时刻，落在既有恢复路径内。
      需要交互入口的调用传 interaction（如聊天请求）；纯探活可不传 */
  request(target: AgentAuthTarget, req: AgentRequestTarget, init?: AgentRequestInit,
          interaction?: InteractionContext): Promise<Response | AgentAuthFailure>;

  /** 严格只读：仅经 provider.inspect() 判断，不刷新、不调 IdP（页面轮询安全） */
  status(target: AgentAuthTarget, interaction?: InteractionContext): Promise<AgentAuthStatus>;
}

type AgentAuthStatus =
  | { state: "not_required" }                                       // 如 none
  | { state: "credential_available" }                               // 乐观状态：本地存在未过期或可静默
                                                                    // 恢复的凭证；不证明未被 IdP 撤销
  | { state: "interaction_required"; interaction?: AuthInteraction } // 未传 InteractionContext 时无 URL
  | { state: "misconfigured"; message: string };
```

**模块内部 adapter seam（provider 协议，值语义、易测试）：**

```ts
type CredentialSnapshot =
  | { kind: "none" }
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string }
  | { kind: "headers"; headers: Record<string, string> };
  // 未来：{ kind: "vercel-oidc" } 等专有 variant，由传输 adapter 映射为双 header

type CredentialVersion = {
  securityRevision: number;                 // connection URL/auth 配置版本
  rotationSeq: number | null;               // 获取型凭证使用；静态族为 null
};

type ProviderFailure = Omit<AgentAuthFailure, "method" | "interaction">;

type CredentialResult =
  | { ok: true; credential: CredentialSnapshot; version: CredentialVersion }
  | { ok: false; failure: ProviderFailure };

type RecoveryDecision =
  | { action: "retry" }
  | { action: "give_up"; failure: ProviderFailure };

type FinalUnauthorizedDecision =
  | { action: "give_up"; failure: ProviderFailure };

interface CredentialProvider {
  readonly method: string;
  /** 可能有副作用（静默刷新）；version 随凭证返回 */
  getCredential(ctx: ProviderContext): Promise<CredentialResult>;
  /** 严格只读：凭证存在性/过期性/本地可恢复性，不刷新、不调 IdP —— status() 的唯一数据源 */
  inspect(ctx: ProviderContext): Promise<
    | { state: "not_required" }               // → not_required（none）
    | { state: "ok" | "recoverable" }        // → credential_available
    | { state: "interaction_required" }      // 模块拼装交互 URL
    | { state: "misconfigured"; message: string }>;
  /** 第一次 401：允许刷新或使用并发写入的新版本重试一次。 */
  recoverUnauthorized(ctx: ProviderContext,
    evidence: { rejectedVersion: CredentialVersion; attempt: 0 }): Promise<RecoveryDecision>;
  /** 第二次 401：类型层面只允许 give_up；版本相同才作废，版本已变化则保留新版。 */
  recoverUnauthorized(ctx: ProviderContext,
    evidence: { rejectedVersion: CredentialVersion; attempt: 1 }): Promise<FinalUnauthorizedDecision>;
}
// ProviderContext：模块构造的领域输入（agentConnectionId、已解密校验的 config、
// securityRevision、按 credentialScope 解析好的 scopeSubject、凭证存取句柄）
```

**交互 URL 的职责链**：注册项以 `interaction.authorizePath` 声明路由基址（如 `/auth/oidc/authorize`）；**模块**在拿到调用方 `InteractionContext` 后用标准 URL API 追加 `chatId` 并校验同源相对路径；**授权路由**收到跳转后做最终校验（chat 归属该 connection、principal 一致，见 B8）。调用方不传 `interaction` 时，`interaction_required` 失败/状态照常返回，只是不含跳转 URL。

**L0 目录（服务端注册表与 UI 描述分离）：**

```ts
// 服务端
interface AuthMethodRegistration {
  method: string;
  credentialScope: "connection" | "principal";
  configSchema: ZodSchema;
  interaction?: { authorizePath: string };  // 启动时校验：同源根相对路径、无 query/hash/dot segments
  provider: CredentialProvider;
}

// 下发给客户端表单（可序列化，不含 zod/provider）
interface AuthMethodFormDescriptor {
  method: string;
  label: string;
  interactive: boolean;
  fields: FieldDescriptor[];
}
```

新增获取方式的全部工作：一个 `AuthMethodRegistration` + 一个表单描述，交互式的再加自己的授权路由。注册表之外无处需要 `switch (method)`。

注册表在进程启动时做一次完整性校验：registration key、`registration.method`、`provider.method`、表单 descriptor method 必须一致；`interactive: true` 必须有合法 `interaction.authorizePath`，非交互 method 不得声明；重复 method 或非法路径直接阻止启动，而不是运行时猜测。

### B3. AuthMethod 目录（对 Eve 全景的完整映射）

| method | 覆盖的 Agent 侧策略 | 族 | 凭证作用域 | 注入形态 | 401 恢复 |
| --- | --- | --- | --- | --- | --- |
| `none` | `none()` / `localDev()` | static | connection | none | give_up（提示 Agent 需要凭证） |
| `basic` | `httpBasic()` | static | connection | basic | give_up（配置错误） |
| `bearer` | `jwtHmac()` / `jwtEcdsa()` / `oidc()` 的静态粘贴 | static | connection | bearer | give_up（token 无效/过期，提示更换） |
| `headers` | 自定义 `AuthFn` 的 header 形态 | static | connection | headers | give_up（配置错误） |
| `oidc-authorization-code` | `oidc()` 的**交互式**获取 | interactive | **principal** | bearer | 版本比对 → refresh → retry ×1；仅永久性错误作废转 interact |
| `oidc-client-credentials`（未来） | `oidc()` 的 **M2M** 获取（RFC 6749 §4.4） | machine | connection | bearer | 重新签发 → retry ×1 |
| `vercel-oidc`（未来） | `vercelOidc()` | machine | connection | 双 header variant | resolver 重取 → retry ×1 |

同一个 Agent 侧 `oidc()` verifier 对应表中三行——用户按 Agent 的文档与自身场景选择获取方式。principal-scoped 凭证代表**某个用户对该 Agent 的授权**；connection-scoped 凭证代表**EveChats 这个部署自身**，全体用户共享、不重复签发。静态族四个 provider 可共用一个 `staticProvider(...)` 工厂。

### B4. 配置模型

`agent_connections` 上：

- `authMethod`：目录中的 method id。
- `authConfigEncrypted`：该 method 的 `configSchema` 实例，AES-256-GCM 加密整体存储；AAD 绑定 `{ agentConnectionId, authMethod }` 与密钥版本，配置密文不能跨 connection/method 替换。
- `securityRevision`：从 1 开始的单调版本；Agent base URL、`authMethod` 或归一化后的 auth config **语义**改变时，在同一事务内 `+1`。单纯密钥轮换/重新加密以及名称、描述等展示字段改变不递增。

`AgentAuthModule` 必须用同一数据库快照加载 connection 与当前 revision 的凭证。配置更新不等待在途网络请求结束，因此旧请求可能完成“旧 URL + 旧凭证”的调用；但 revision 约束保证任何新请求、refresh 写回或 callback 都不能把旧凭证与新 URL/配置组合。旧 revision 的凭证不再命中，后台异步清理。

各 method 的配置形状：

```
none                     → {}
basic                    → { username, password }
bearer                   → { token }
headers                  → { headers: Record<name, value> }
oidc-authorization-code  → { issuer, clientId, clientSecret?,
                             tokenEndpointAuthMethod?,   // 阶段 1：client_secret_basic | client_secret_post | none
                                                         // private_key_jwt 延后到补齐 key/kid/alg 配置的阶段
                             audienceMode?,              // "resource" | "audience" | "both"
                             audience,
                             scopes?,                    // 默认 ["openid","offline_access"]；归一化强制含 openid；
                                                         // 显式移除 offline_access ＝ 接受不可静默续期
                             promptConsent? }            // 默认 true（见 C1 §11 行）
```

要点：

- **issuer/clientId 属于 per-agent 配置**（任意 IdP），环境变量只作为部署级默认值回填。
- **预检分两级，只承诺各自能证明的事**：
  - **保存时**：discovery 可达、必需端点存在、所选 `tokenEndpointAuthMethod` 受 metadata 支持、受众配置形式合法；`token_endpoint_auth_methods_supported` 缺失时按 OIDC Discovery 默认值 `client_secret_basic` 解释，不把“字段缺失”误判成“不支持”。Discovery **不能**证明 IdP 最终签发 JWT access token。
  - **首次授权 callback 时**：经 `AccessTokenVerifier`（见 C2，含 best-effort 错误分类）验证取回的 access token；配置性不通过 → `configuration_invalid`，**不写入凭证表**；暂时性 discovery/JWKS 故障则保存不可出站使用的 `pending_verification`，避免丢失已经签发/轮换的 refresh token。

### B5. 凭证存储模型

静态配置存在 connection 上（B4）；**获取型凭证**存进通用凭证表：

```
agent_credentials
  agent_connection_id -- 隔离的第一维度（外键，Agent 删除级联清理）
  security_revision   -- 写入时的 connection 安全版本；只读取当前版本
  credential_scope    -- "connection" | "principal"（显式列）
  scope_subject       -- principal-scoped: principal_id；connection-scoped: ""
  auth_method         -- "oidc-authorization-code" | ...
  credential_key      -- provider 内部判别键（默认 ""）
  payload_encrypted   -- opaque，AES-256-GCM，provider 自解释
  expires_at          -- 快速过期判断与后台清理
  refresh_owner       -- 当前租约持有者实例 id（可空）
  refresh_lease_id    -- 本次租约的一次性 id（fencing token，可空）
  refresh_lease_until -- 租约到期时间（可空，短 TTL 防实例崩溃死锁）
  rotation_seq        -- 凭证版本（单调递增）
  UNIQUE (agent_connection_id, security_revision, auth_method,
          credential_scope, scope_subject, credential_key)
```

- **凭证严格按 connection 隔离，无隐式共享**（恶意 Agent 声明相同 issuer/audience 即可套取 token；共享须经未来显式 `credential_profile`）。
- 数据库 `CHECK` 强制 scope 形状：`connection` 必须对应空 `scope_subject`，`principal` 必须对应非空值；`security_revision`、`rotation_seq` 非负。注册项 scope 与凭证行不一致时模块 fail closed。
- payload 对存储层完全不透明；OIDC payload 自含状态、`subject`、`issuer`、token 等字段（见 C2），可续期性由 refresh token 是否存在推导。payload 的 AES-GCM AAD 绑定 `{ agentConnectionId, securityRevision, credentialScope, scopeSubject, authMethod, credentialKey }`，数据库中的密文不能跨行或跨 revision 替换。
- **刷新并发协议（先取权 + fencing，后调 IdP）**：
  1. 进程内：按凭证行 singleflight；
  2. **抢租约（带版本）**：`UPDATE … SET refresh_owner = $me, refresh_lease_id = $newId, refresh_lease_until = now() + TTL WHERE <行> AND security_revision = $安全版本 AND rotation_seq = $读取版本 AND (refresh_owner IS NULL OR refresh_lease_until < now())`——版本条件保证抢到的是"还没被别人刷新、配置也没改变"的那一版；抢占失败**不调用 IdP**，等待后重读凭证；
  3. 取得租约后**重读凭证行与 connection revision**，确认版本未变、用最新 refresh token 调 IdP；token endpoint 的请求超时**严格短于**租约 TTL（避免旧持有者尚在途中租约已过期）；
  4. **最终写入四重校验**：`refresh_owner`、`refresh_lease_id`、`security_revision`、`rotation_seq` 全部匹配，并在同一事务确认 connection 当前仍是该 `security_revision`；写入时 `rotation_seq + 1` 并清空租约。任一条件不满足即放弃写入、重读。
  5. 成功、暂时性失败和永久性失败都用相同 fencing 条件释放租约或删除凭证；旧持有者不得无条件清租约/删行。进程异常则依靠 TTL 回收。

  **保证边界（诚实声明）**：以上在正常并发下保证至多一个执行体调用 token endpoint。实例崩溃、网络结果不确定的场景存在不可消除窗口——典型如"IdP 已完成轮换、数据库写入前实例崩溃"，新 refresh token 丢失；该窗口的后果由错误分级兜底（下次刷新 `invalid_grant` → 重新授权），不假装能消除。

**迁移原则**：`agent_connections.security_revision` 以 1 起步；只有能够证明与当前 connection URL/auth config 同源的现有凭证才可标记为 revision 1。来源或绑定关系不完整的旧 token fail closed 为待重新授权，不用“尽量复用”换取潜在的跨目标泄漏。迁移期间先部署能双读旧 schema 但只写新 revision 的代码，再完成回填/作废，最后移除旧读路径；任一阶段都不允许把无 revision token 发往已修改的 connection。

### B6. 调用管道（method 无关）

proxy 对每类操作都是同一行编排：

```
turn      → agentAuth.request(target, { pathname: "/eve/v1/session[/:id]" },
                              { method: "POST", jsonBody }, { chatId })
info 探活 → agentAuth.request(target, { pathname: "/eve/v1/info" })
stream    → agentAuth.request(target,
                              { pathname: "/eve/v1/session/:id/stream",
                                searchParams: { startIndex: String(n) } },   // 结构化传递——
                              { signal }, { chatId })                        // Client.fetch 无法携带 query（B9）
  ├─ Response         → 转发（流式的持久化见下）
  └─ AgentAuthFailure → 按 B7 映射为结构化响应
```

**流式路由走 `request()` 原始 `Response`（P0 契约约束，v4 确立）**：eve 的 stream 帮手是懒执行 `AsyncIterable`，认证失败发生在首次拉取后，union 返回无失败通道；原始 Response 的 401 在响应头时刻可见，恢复留在 `request()` 内。

**流式持久化：单读者"先持久化、后转发"，不用原生 `tee()`**（原生 `tee()` 在慢分支会无界积压）：

- proxy 以 pull 循环消费上游 body：读一行 NDJSON → 持久化事件 → enqueue 给浏览器——下游 `ReadableStream` 的 pull 语义天然形成背压，持久化慢则上游读取慢，无积压、无额外内存上限需求；
- 浏览器断开（`cancel`）→ 经 AbortController 取消上游请求；
- **200 之后的认证失效**没有带内通道：流直接结束；浏览器带新 `startIndex` 重连，每次重连是一次全新的 `request()`（新凭证 + 401 恢复），events 表的 `(chatId, sessionId, streamIndex)` 唯一键保证重复持久化幂等。

模块内部流程（所有受保护调用共用）：

```
同一快照加载 connection + securityRevision → 解密并按 configSchema 校验
→ 解析 (credential_scope, scope_subject) → 只读取当前 securityRevision 的凭证
getCredential(ctx) → { credential, version: V1 = { securityRevision, rotationSeq } }
  ├─ failure → 归一化返回（盖章 method；有 InteractionContext 时拼装交互 URL）
  └─ ok → 传输 adapter 构造 URL + 物化 header（凭证最后写入）→ 发起调用
      ├─ 401 → recoverUnauthorized(ctx, { rejectedVersion: V1, attempt: 0 })
      │    ├─ retry   → 重新 getCredential（若他处已刷新，直接得到新版；否则 provider 已刷新）→ 重发一次
      │    │             再 401 → recoverUnauthorized(ctx, { rejectedVersion: V2, attempt: 1 })
      │    │                       ├─ 当前版本 = V2 → provider 作废 V2，interaction_required / credential_rejected
      │    │                       └─ 当前版本 ≠ V2 → 保留并发新版，retry_required
      │    │                       （类型只允许 give_up；模块不再发起第三次请求）
      │    └─ give_up → 归一化返回
      ├─ 403 → forbidden（永不刷新、永不重试）
      └─ 其他 → 原样返回，由调用方处理业务错误
```

**传输 adapter 的出站安全契约**：

- `AgentRequestTarget.pathname` 必须以单个 `/` 开头，拒绝 scheme/authority、`?`、`#`、反斜线、原始或百分号编码的 dot segments；session id 等动态 path segment 先独立编码再拼装。`searchParams` 只经标准 URL API 写入。
- Agent base URL 与 OIDC issuer 只允许配置的 `http/https` 策略：生产默认 HTTPS、禁止 URL userinfo/query/hash（允许非根 pathname 作为部署前缀）；discovery/JWKS URL 同样禁止 userinfo/hash，并由标准 URL API 管理 query。loopback、link-local、云 metadata 与私网目标默认拒绝，需要部署级 allowlist 才能开放。Discovery 返回的 `jwks_uri` 再次执行相同策略，并默认要求与 issuer 同源或进入显式 allowlist。
- 应用层校验之外，生产部署必须有网络层 egress policy；它覆盖 `openid-client`、Eve `verifyOidc` 等内部自行 fetch、无法注入自定义 fetch 的库，防止 DNS rebinding/TOCTOU 绕过单次解析检查。本地开发按显式开关放行 loopback。
- `headers` provider 在保存时拒绝 hop-by-hop/传输控制与代理身份字段（至少 `host`、`content-length`、`connection`、`keep-alive`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`proxy-*`、`forwarded`、`x-forwarded-*`）；Bearer/Basic/自定义 header 均在业务字段之后物化。显式配置的 `Cookie` 可作为 Agent 凭证，但绝不转发 EveChats 入站 cookie。空白 bearer、非法 header 名/值直接 `configuration_invalid`，绝不降级为匿名请求。
- `redirect: "manual"` 是硬约束；任何 3xx 原样返回，不把凭证带到 `Location`。调用方取消产生的 `AbortError` 作为取消信号传播，不伪装成 `upstream_unavailable`；真正的网络不可达才归一化为该错误。

**探活三层**（F8）：

```
liveness        → 匿名 fetch（无任何凭证）GET /eve/v1/health   ← 官方规定永远公开
auth readiness  → agentAuth.request(target, { pathname: "/eve/v1/info" })
chat readiness  → 真实 session 路径的结果
```

管道里没有任何 method 分支；恢复策略差异全部被 provider 吸收，编排差异全部被模块吸收。

### B7. 错误分类与前端契约

领域错误码与 HTTP 映射（proxy 对前端的稳定契约）：

| code | 含义 | HTTP | 恢复语义 |
| --- | --- | --- | --- |
| `interaction_required` | 需要用户完成授权交互 | 401 | 有 `interaction` 时 UI 渲染行动按钮；纯探活可只展示状态 |
| `credential_rejected` | 凭证被 Agent 拒绝且无法自愈 | 401 | 提示检查/更换凭证 |
| `forbidden` | Agent 明确拒绝该主体 | 403 | **永不刷新**，纯展示 |
| `configuration_invalid` | EveChats 侧配置缺失/损坏/不满足预检 | 422 | 引导去编辑 Agent 配置 |
| `provider_unavailable` | IdP/凭证源暂时不可用 | 503 | 可稍后重试，**不作废已存凭证** |
| `upstream_unavailable` | Agent 本身不可达 | 502 | 探活/稍后重试 |
| `retry_required` | 本请求重试预算用尽，但并发产生了尚未被拒绝的新凭证 | 409 | 保留新凭证；调用方可安全重发整个请求 |

响应形状即 `AgentAuthFailure` 本身（`method` 字段由模块盖章，类型与响应一致）：

```json
{
  "code": "interaction_required",
  "method": "oidc-authorization-code",
  "message": "…",
  "interaction": { "type": "redirect", "url": "/auth/oidc/authorize?chatId=…" }
}
```

chat 界面、探活、未来任何消费方都只处理这一种契约。配套 method 无关的状态查询 `GET /api/agent-auth/status?chatId=…`，直接返回 `AgentAuthStatus` discriminated union（内部即 `AgentAuthModule.status`，只读、经 `provider.inspect()`，页面轮询不触发 refresh；`credential_available` 是乐观状态，最终判定以真实调用为准）。

### B8. 交互式授权框架

交互式 provider 的对外契约只有两条：

1. `inspect` / `getCredential` 在无凭证时返回 `interaction_required`；注册项的 `interaction.authorizePath` 声明**路由基址**，最终跳转 URL 由模块拼装（追加 `InteractionContext`）并校验为同源相对路径；若 provider 返回 `interaction_required` 但注册项没有 interaction 描述，模块 fail closed 为 `configuration_invalid`；
2. 交互完成后，凭证出现在 B5 的存储里，之后的 `getCredential` 返回 `ok`。

授权中间过程（路由、事务、回调）是 provider 私有实现，挂 `/auth/:method/*` 命名空间。通用部分下沉为共享设施：

- **caller principal cookie**（至少 128-bit 随机匿名会话 id；生产使用 `__Host-` 前缀、HttpOnly/SameSite=Lax/Secure、Path=/、无 Domain，身份升级时轮换）——所有交互式 method 共享；
- **密封工具**（AES-256-GCM + 记录身份/`securityRevision` AAD + 密钥版本前缀）——事务与凭证 payload 共用；
- **state-keyed 事务**：授权事务按 `state` 分键存取（cookie 名含 state 指纹，或服务端事务表），多标签页并发授权互不覆盖；单事务 10 分钟过期、一次性消费；
- **事务绑定与归属校验**：事务内容至少绑定 `{ state, agentConnectionId, securityRevision, principalId, chatId, returnTo }`；authorize 路由收到跳转时即校验 chat 归属该 agent connection、principal 与发起者一致；callback 写凭证前在同一事务复核 connection 当前 revision，配置已变化则拒绝旧 callback、要求重新发起授权；`returnTo` 由服务端从 `chatId` 推导（允许列表内的同源路径，如 `/chats/:id`），不接受任意传入。
- **同目标多 callback 语义**：同一 `(connection, revision, principal, method, key)` 的成功 callback 经原子 upsert 串行化，最后完成者生效；每次都递增 `rotation_seq`，不会静默覆盖却不改变凭证版本。

### B9. 关键决策记录

| 决策 | 理由 |
| --- | --- |
| 获取方式显式配置，不自动发现 | 默认 401 challenge 只有 Basic/Bearer 粒度；自动探测必然误判（研究文档 §6） |
| method 按获取方式命名，不照抄 verifier 名 | `oidc()` 只验 bearer；同一 verifier 对应多种获取（研究文档 §2） |
| 凭证按 (agent, scope) 严格隔离；作用域显式成列 | 隐式共享＝恶意 Agent 可套取 token；机器凭证归属部署而非浏览器用户 |
| connection 安全相关字段用 `securityRevision` 绑定凭证、refresh 与授权事务 | connection id 是可变记录，不是不可变安全身份；URL/issuer/client/audience 改变后不能复活旧 token，旧 callback 也不能写回 |
| 外部接口只有 `request` + `status`，流式走原始 Response | stream 帮手懒执行，union 返回无失败通道；原始 Response 401 在响应头时刻可见；重连即新请求 |
| **传输 adapter 自持 fetch，不经 `Client.fetch`** | 已验证（`eve@0.24.3` `client/url.js`、`client.js`）：① 绝对 host 下 path 赋给 `URL.pathname`，query `?`→`%3F`，且 `createClientUrl` 的 searchParams 参数未被 `Client.fetch` 暴露——重连 `startIndex` 无法传递；② header 合并 init.headers 覆盖 options.headers，业务 header 可覆盖 `headers` 类凭证。复用对象是 ClientAuth 线格式契约，不是封装 |
| 请求目标结构化（pathname + searchParams），init 收窄为 AgentRequestInit | query 不进 pathname；不接受任意 headers（防凭证覆盖/走私）；jsonBody 可重放由构造保证（401 重试安全） |
| 交互上下文与凭证归属分离；注册项声明 authorizePath，URL 由模块拼装、授权路由终校验 | provider 不感知 chat；returnTo 服务端推导；无 interaction 描述却要求交互时 fail closed；`status()` 经 `inspect()` 保持只读 |
| 刷新权在调用 IdP **之前**取得，租约带 fencing（lease_id + security/rotation 版本） | 事后 CAS 防不住并发使用同一 refresh token（reuse detection 撤销 token family）；无 fencing 的租约防不住过期旧持有者写回 |
| 401 恢复基于被拒凭证版本；第二次 401 的类型只允许 give_up | 无版本会误伤并发新版；第二次 401 若发现新版则保留并返回 `retry_required`，不刷新、不发第三次请求 |
| 每个 token response 都经过 AccessTokenVerifier 激活门；暂时失败落 pending | refresh 也可能返回 opaque/错误受众 token；先保存已轮换 refresh token 再等待复验，避免回退使用旧 token |
| 只做 in-flight singleflight，不长期缓存凭证快照 | 恢复后的重试必须读到新 token；如引入缓存须以 `{securityRevision, rotationSeq}` 为版本并在恢复路径失效 |
| 凭证全程服务端托管 | token 不可被浏览器脚本读取；XSS 仍可借会话代发请求，属常规会话防护范畴 |
| 401 恢复最多一次；403 永不恢复 | 防刷新风暴；403 是授权问题，刷新无意义（研究文档 §8） |
| `status()` 只读（经 `inspect()`），`credential_available` 为乐观语义 | 轮询不产生 refresh 副作用；只读无法证明未撤销，最终判定在调用路径 |
| 流式持久化单读者先持久化后转发，不用原生 `tee()` | 原生 tee 慢分支无界积压；pull 循环天然背压，断开经 AbortController 取消上游 |
| 出站 URL/header 统一 policy + 生产网络层 egress guard | 自持 fetch、OIDC discovery/JWKS 都是 SSRF 面；应用层 DNS 检查存在 TOCTOU，库内部 fetch 也必须由网络层兜底 |
| 出站统一 `redirect: "manual"`；interaction.url 限同源相对路径 | 凭证不跟随跨域重定向泄漏；不引导用户跳任意外链 |
| principal 维度从第一天进 schema | 未来接用户体系只迁移 principal 来源，不动凭证模型 |

---

## Part C · `oidc-authorization-code`：第一个 interactive provider

B2 契约的一个实现，`credentialScope: "principal"`，协议层全部复用 `openid-client` v6（certified）。

### C1. 标准遵循

| 标准 | 用法 |
| --- | --- |
| OIDC Core 1.0 | Authorization Code Flow；`nonce` 绑定 ID token |
| OIDC Discovery / RFC 8414 | `${issuer}/.well-known/openid-configuration` 自动发现，配置缓存 |
| RFC 6749 §4.1 / §6 | 授权码换 token；refresh token grant |
| RFC 7636 (PKCE, S256) | **无条件启用**（RFC 9700 / OAuth 2.1 BCP），与 client 类型无关 |
| Client authentication | 按配置 `tokenEndpointAuthMethod`：阶段 1 支持 `client_secret_basic` / `client_secret_post` / `none`；`private_key_jwt` 待补齐 key/kid/alg 配置后加入 |
| OIDC §11 | **默认 scope 同时含 `openid` 与 `offline_access`**（只带 `prompt=consent` 不申请离线权限），且默认携带 `prompt=consent`——§11 规定无其他既存 consent 条件时 OP 会忽略离线请求；对已有 consent 机制的 IdP 可经 `promptConsent: false` 关闭；显式移除 `offline_access` ＝ 接受不可静默续期 |
| RFC 8707 / Auth0 `audience` | 受众声明按 `audienceMode` 选 `resource` / `audience` / 双发（IdP 支持不一） |
| RFC 9068 | **优先支持** RFC 9068 profile 的 JWT access token；实际最低要求是 Agent 端 `oidc()` 能按 issuer/JWKS/audience 验证的 JWT（Eve 的校验比 9068 宽松，二者不等同）。发送 access token 而非 ID token |

### C2. provider 行为映射到 B2 契约

- **凭证 payload 是带状态的 union**（行同时绑定 `security_revision`，凭证版本为 `{ securityRevision, rotationSeq }`）：
  - `active`：`{ state: "active", accessToken, refreshToken?, subject, issuer, obtainedAt }`；只有本状态可以物化 bearer；
  - `pending_verification`：`{ state: "pending_verification", candidateAccessToken, refreshToken?, subject, issuer, obtainedAt }`；token endpoint 已成功且 refresh token 可能已轮换，但 access token 因暂时性 discovery/JWKS 故障尚未完成验证。该状态不得发给 Agent，后续 `getCredential` 只重试验证，不再次调用 token endpoint。
  `expires_at` 冗余存 active/candidate access token 的过期时间；可续期性由是否存在 refresh token 推导，不再作为可能失真的独立布尔值存储。callback 首次插入 `rotation_seq = 0`；若当前 revision 已有凭证，callback re-authorization 用原子 upsert 写入并基于现值 `rotation_seq + 1`、清理旧租约，使在途 refresh 因 fencing 失败。refresh 写 active/pending、pending 激活及其他 payload 状态变化都按 CAS 递增 `rotation_seq`，使在途请求能识别状态已经变化。
- **subject 语义**（OIDC Core §12.2：refresh response **可以不含** ID token）：
  - 初始 `subject` 来自**经 `openid-client` 完整验证的 ID token**；
  - refresh 返回新 ID token 时，经验证后比较 `iss`/`sub`/`aud`，不一致视为异常作废凭证；
  - refresh 未返回 ID token 时，**保留原 subject**，不做任何推断；永不从未验签的 access token 推断身份。
- **AccessTokenVerifier（所有 token response 的激活门）**：callback 和每次 refresh 返回的 access token 都必须先经过它，验证通过才能写成 `active` 并对 Agent 使用。实现复用 Eve 公开的 `verifyOidc(token, { issuer, audiences: [audience] })`——与 Agent 端校验机制**同构由构造保证**。两点边界：
  - **错误分类是 best-effort**：`verifyOidc` 的 `VerifyResult` 刻意只有 `{ok:false}`，内部 discovery/JWKS 网络失败也折叠为 false。分类流程：先经我们自己的 discovery/JWKS 可达性确认（失败 → `provider_unavailable`，重试一次），可达后 `verifyOidc` 为 false → `configuration_invalid`。残余歧义（eve 内部瞬时网络失败）无法消除，以重试缓解，文档不做更强承诺；
  - **证明边界**：通过只说明 token 与 Eve OIDC 验证机制兼容，**不能**保证远端 Agent 额外的 `subjects` / `claims` 约束放行——auth readiness 的 `/info` 才是最终判断。
- **token response 归一化与激活**：callback 没有旧 refresh token；refresh 时 `nextRefreshToken = response.refreshToken ?? currentRefreshToken`（返回新值即替换，未返回则保留旧值）。先完成 ID token/subject 校验，再验证 access token：
  - 验证成功 → 以 fencing/revision 条件原子写入 `active`；
  - discovery/JWKS 等暂时性验证失败 → 以同样条件保存 `pending_verification`，其中必须带 `nextRefreshToken`（若 IdP 已轮换，绝不退回旧 token），返回 `provider_unavailable`；
  - 已确认可达后的签名/issuer/audience/格式失败 → 不激活 access token；callback 不落库，refresh 路径按 fencing 条件删除旧凭证并返回 `configuration_invalid`，要求修复配置后重新授权。
- **无 refresh token 的降级路径**：callback 未返回 refresh token 时仍保存 `active` access token；到期后 `getCredential` / `inspect` 给出 `interaction_required`，不尝试静默续期。
- **`inspect`**（只读）：未过期 active → `ok`；active 过期但有 refresh token、pending candidate 尚未过期、或 pending 带 refresh token → `recoverable`；active/pending 均已过期且无 refresh token、或无凭证 → `interaction_required`；配置无法解析 → `misconfigured`。全程无网络调用。
- **`getCredential`**：未过期 active → `bearer` + version；未过期 pending → 只重试 AccessTokenVerifier，成功后激活、暂时失败保持 pending、确认配置性失败则按版本删除 pending 并返回 `configuration_invalid`；pending 已过期但有 refresh token → 直接刷新并经过激活门；active 过期且有 refresh token → 同样刷新；否则 → `interaction_required`。
- **刷新规则**：
  - 刷新前必须取得 B5 的**带 fencing 租约**（进程内 singleflight + 抢占校验 security/rotation 版本 + 取得后重读 + 四重校验写入；token endpoint 超时严格短于租约 TTL）；
  - `invalid_grant` 等**永久性** OAuth 错误 → 按 lease/revision fencing 作废凭证 → `interaction_required`；
  - 网络错误 / IdP 5xx 等**暂时性**错误 → **保留** refresh token → `provider_unavailable`。
- **`recoverUnauthorized(ctx, { rejectedVersion, attempt })`**：
  - `attempt = 0`：当前版本不同 → `retry`（他处已刷新，不动新版）；版本相同且有 refresh token → 按上述规则刷新后 `retry`；不可续期/永久失败 → 作废匹配版本并 `give_up(interaction_required)`；
  - `attempt = 1`：**绝不刷新、绝不返回 retry**。当前版本仍等于 rejectedVersion → 作废该版本并 `give_up(interaction_required)`；当前版本已变化 → 保留未被本请求拒绝的并发新版，`give_up(retry_required)`，调用方可安全重发整个请求。
- **授权路由**（provider 私有）：
  - `GET /auth/oidc/authorize`：**先校验交互上下文**（chat 归属该 connection、principal 一致，B8 职责链终点）→ 生成 PKCE verifier / `state` / `nonce`，事务按 `state` 分键密封并绑定 `{ agentConnectionId, securityRevision, principalId, chatId, returnTo }`，302/307 → IdP（按 C1 携带 `prompt=consent`）；
  - `GET /auth/oidc/callback`：按 `state` 取事务并一次性消费 → 校验事务与 principal 绑定、`state`/`nonce`/PKCE、issuer/redirectUri/受众一致性 → `authorizationCodeGrant` → **AccessTokenVerifier 激活门** → 在同一事务确认 connection 的 `securityRevision` 未变化后原子 insert/upsert active/pending payload（已有行则 `rotation_seq + 1` 并清理旧租约，使并发 refresh 迟到写回失败）；revision 已改变则拒绝旧 callback、要求重新授权 → 303 回服务端推导的 `returnTo`。

### C3. principal 语义

我们的 bearer 经 Agent 端 generic `oidc()` 验证后 principal 为 `service` 类型。若某 Agent 需要 `principalType: "user"`（做用户级 connection OAuth），那是 Agent 侧用自定义 `AuthFn` 或 `vercelOidc` `external_sub` 的选择，EveChats 不做假设、不为此特化。

---

## Part D · 演进路线

1. **阶段 1**：`AgentAuthModule`（`request`/`status`）+ `securityRevision` 迁移 + 传输 adapter（结构化目标、自持 fetch、线格式对齐、URL/header policy）+ 静态族四 method + `oidc-authorization-code` provider（带 fencing 租约、版本化 401 终态、state-keyed/revision-bound 事务、token response 激活门与 pending 状态、错误分级、`prompt=consent` + 默认 `offline_access`、`inspect` 只读）+ Part E 自动化验收——本设计的验收线。
2. **阶段 2**：per-agent issuer 管理体验（表单、保存级预检）、`audienceMode` 双模式、`tokenEndpointAuthMethod` 补齐 `private_key_jwt`、后台过期凭证清理、`credential_profile` 显式共享（如确有需求）。
3. **阶段 3**：machine 族——`oidc-client-credentials`、`vercel-oidc`（connection-scoped）；`WWW-Authenticate` 提示性探测（仅 UI 提示，不改配置）。
4. **阶段 4**：EveChats 用户体系接入——principal 来源从匿名会话切换为用户 id；**匿名 principal 下的既有授权不自动转移**，须重新授权或经显式认领流程绑定到登录用户。

---

## Part E · 验收与测试策略

**测试面就是 `AgentAuthModule` Interface**：业务调用方和行为测试都只经 `request()` / `status()`；`CredentialProvider`、传输、数据库与 IdP 是模块内部 Seam。普通行为测试可用 PGLite、脚本化 fetch 与本地 OIDC mock；租约、事务隔离和跨连接并发必须跑隔离的真实 Postgres，不能用单进程内存替身证明。测试断言可观察的 Response、Failure、状态与持久化结果，不依赖 provider 内部调用顺序；并发测试除外，它额外断言 token endpoint 实际调用次数。

### E1. Interface 行为矩阵

| 场景 | 必须断言 |
| --- | --- |
| `none` / static / interactive | `status` 分别得到 `not_required` / `credential_available` / 可选 URL 的 `interaction_required`；轮询不产生网络请求 |
| interaction context 缺失/存在 | 缺失时仍返回 `interaction_required` 但无 URL；存在时 URL 同源、chatId 正确编码；无注册 interaction 描述时 fail closed |
| 401 → 恢复成功 | 只重发一次，第二次请求使用新 `CredentialVersion` |
| 第二次 401，版本未变 | 不发第三次请求；只作废被拒版本；返回 interaction/credential failure |
| 第二次 401，并发版本已变 | 不作废新版；返回 `retry_required`；调用方重发后使用新版 |
| 403 | provider 不刷新、不作废、不重试 |
| AbortSignal | 上游 fetch 被取消；取消不映射为 upstream unavailable |

### E2. Revision 与竞态矩阵

| 场景 | 必须断言 |
| --- | --- |
| Agent URL/authMethod/authConfig 更新 | `securityRevision + 1`；旧凭证不命中；新请求不会把旧 token 发给新 URL |
| 授权开始后配置更新 | 旧 callback 因 revision 不匹配被拒，不能写入当前 revision |
| callback re-authorization 与 refresh 并发 | callback upsert 递增 rotation、清理旧租约；迟到 refresh 因 fencing 失败，不能覆盖新授权 |
| refresh 途中配置更新 | 最终四重校验失败；旧持有者不能写 token、删新版或清理新租约 |
| 两实例同时刷新 | token endpoint 正常并发下只调用一次；失败方等待并重读 |
| 租约超时/旧持有者迟到 | `lease_id` fencing 阻止迟到写回；不满足 fencing 的删除/释放同样失败 |
| IdP 成功后实例在 DB 写入前崩溃 | 下次 `invalid_grant` 转重新授权，且不会假装恢复出已丢失的新 refresh token |

### E3. OIDC token response 矩阵

| 场景 | 必须断言 |
| --- | --- |
| callback/refresh 返回可验证 JWT access token | 只有验证通过后才进入 active 并可物化 bearer |
| refresh 不返回新 refresh token | 保留旧 refresh token |
| refresh 返回新 refresh token | 原子替换旧 token；后续绝不回退旧值 |
| AccessTokenVerifier 暂时失败 | 保存 pending candidate 与归一化后的 refresh token；不向 Agent 发送 candidate；重试验证不再次 refresh |
| AccessTokenVerifier 配置性失败 | access token 不激活；callback 不落库，refresh 按 fencing 作废并返回 configuration invalid |
| pending 复验转配置性失败 | 按版本删除 pending，返回 configuration invalid，不发送 candidate、不回退旧 refresh token |
| refresh response 无 ID token | 保留原 subject；有 ID token 时验证并比较 iss/sub/aud |

### E4. 传输与安全矩阵

| 场景 | 必须断言 |
| --- | --- |
| stream `startIndex` | query 经 `searchParams` 传递，不进入 pathname；重连从正确 index 开始 |
| NDJSON 持久化失败 | 未持久化事件不转发；上下游取消；浏览器可从最后已确认 index 重连 |
| 浏览器断开 | cancel 传播至上游，无后台无界读取或缓存 |
| 非法 pathname/header | absolute URL、dot segments、query-in-path、hop-by-hop header、空白 bearer 全部 fail closed |
| Agent/issuer/JWKS URL | 应用 policy 与部署 egress policy 都覆盖；私网/metadata 默认拒绝，显式 allowlist 场景单独测试 |
| 3xx | `redirect: manual`；认证 header 不发送到 Location |

阶段 1 完成条件：以上矩阵全部自动化通过，并至少有一条端到端用例连接本地 OIDC mock → 完成 code flow → 创建 Eve session → 中断并携带 `startIndex` 重连。测试不启动常驻开发服务，所需 mock 在测试进程内按用例生命周期创建与销毁。
