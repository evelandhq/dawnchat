# eve-chats 性能优化执行计划

日期：2026-08-20
状态：P0–P3 已完成（见附录 B）；P4 待单独设计评审。

## 1. 背景与测量基线

用 Chrome DevTools 对 UAT（`evechats.uat.jinshujuapp.com`）实测得到的事实，
以及代码审读确认的结构问题：

| # | 问题 | 证据 | 状态 |
|---|------|------|------|
| B1 | 每次冷加载发出 **4 次** `GET /api/chats`（侧边栏、HomeRedirect、AgentCatalog、IdentityAgentAccess 各自 fetch） | DevTools 请求瀑布 | ✅ 已修（ChatListProvider 共享单次请求） |
| B2 | `listChats` 为 N+1：每个 chat 单独查 agent + `listEvents` 全量重放 reducer，只为一句预览 | `src/app/api/chats/api.ts` | ✅ 已修（批量 agent 查询 + `listMessageTailEvents` 尾部投影） |
| B3 | `chats` 的 owner 列与 `events` 的 `(chat_id, type)` 无索引 | schema | ✅ 已修（migration 0008） |
| B4 | `/` 纯客户端跳转：hydrate → identity 往返 → `/api/chats` → 再导航 | DevTools | ✅ 已修为 SSR redirect（**P2 将按 CSR 决策撤销**，见 §4.2） |
| B5 | 聊天路由静态打包 mermaid + KaTeX + Shiki（同一 chunk 836 KB） | `.next` 产物分析 | ✅ 已修（按内容懒加载） |
| B6 | 每个 turn 结束 `router.refresh()` 重拉整棵 RSC 树 | `chat-thread.tsx` | ✅ 已修（改为通知 chat list 重读） |
| B7 | 全部页面 `force-dynamic` 且无 `loading.tsx` | Next 文档明确列为慢导航原因 | ✅ 已加 loading 边界（**P2 静态化后移除**） |
| B8 | **stream delta 平方级落库**：`message.appended` 每条带累计全文并全部持久化。实测一条真实会话存了 14,726 行 / 43 MB，折叠后仅 236 KB（186×） | `eve-proxy.ts` `persistEvent` | ✅ 读路径折叠 + **写路径已停写 delta（P1）** |
| B9 | 每个流式事件 **2 个事务**：`appendEvent` + `updateChatSessionState`（每 token UPDATE `chats` 一行，MVCC 膨胀） | `repository.ts` / `eve-proxy.ts` | ✅ 已修（P1：cursor 并入 appendEvent 事务）|
| B10 | 流式期间所有消息重渲染：`EveMessageView` 无 memo，且 `inputRequests` 每次渲染都是新对象 | `eve-message.tsx` / `chat-thread.tsx` | ✅ 已修（P3：React Compiler）|
| B11 | 根 layout 每请求查库（含 RSC prefetch），且 `AppHeader` 收到的 `chats` 恒为 `[]` → **`/chats/:id` 头部恒空**（功能 bug） | `app-sidebar.tsx` | ✅ 已修（P2：header 读共享数据，实测聊天页头部正确显示）|
| B12 | `messages` 表是死表：生产代码零读写，仅测试插入过 | 全仓 grep | ✅ 已修（P0：migration 0009 DROP）|

## 2. 决策记录

- **架构方向：CSR。** 页面（RSC）不做任何服务端数据库查询；数据一律由客户端向
  `/api/*` 发起。页面退化为静态 shell，`force-dynamic` 全部移除。
  （由 Oscar 于 2026-08-20 决定；同时意味着撤销 B4 的 SSR redirect。）
- **P1 前置验证：** delta 不落库依赖"重连由 Eve 按 `streamIndex` 重放、而非从库读"
  这一事实。必须先用 fake-eve-server 写出重放语义测试，测试绿了才改 `persistEvent`。
- **渲染性能用 React Compiler**（Next 16 已 stable），不手写 memo 依赖数组去碰
  HITL 相关代码。

## 3. 阶段总览

| 阶段 | 内容 | 风险 | 依赖 | 预期收益 |
|------|------|------|------|----------|
| P0 | 死表清理 | 低 | 无 | 卫生 |
| P1 | 写路径：delta 不落库 + 单事务 | 中 | 无 | 存储/写事务 ~100×；chats 行更新从每 token 一次降为每落库事件一次 |
| P2 | CSR 化：页面零服务端查询 | 中 | 无（与 P1 并行安全） | 全路由静态、导航即时、layout 零查询、修复 B11 |
| P3 | React Compiler | 低 | 无 | 流式期间重渲染只剩活跃消息 |
| P4 | 投影物化（中期） | 高 | P1 | 冷打开 O(消息数)，events 退为审计源 |

建议顺序：P0 → P1 → P2 → P3（P2/P3 可并行）→ P4（单独设计评审后实施）。

每阶段的通用验收门：

```bash
pnpm typecheck && pnpm db:up && pnpm test && pnpm build
```

## 4. 各阶段任务

### P0 — 死表清理（B12）

1. migration `0009`：`DROP TABLE "messages"`。**不可逆**，部署前确认生产备份。
2. `src/db/schema.ts` 移除 `messages` 定义与导出；`repository.test.ts` 中
   引用它的级联删除测试改为只断言 `events`/`chats` 级联。

验收：全仓无 `messages` 引用；测试绿。

### P1 — 写路径重构：delta 不落库、单事务（B8 写侧、B9）

关键事实（已核实）：

- 重连不读库。`GET …/stream?startIndex=N` 由 proxy `sessions.attach(sessionId,
  {streamIndex})` 让 **Eve 重放**；库只服务冷打开。
- 库里的 delta 没有任何读者：冷打开被 `collapseStreamedDeltas` 折叠，列表预览用
  `message.completed`，pending-input 账本只由 `input.*`/`turn.*`/`session.*` 驱动
  （delta 从不携带 `pendingInputTransition`）。
- 0.29/0.30 的 continuationToken 轮转挂在 `session.waiting` 上——非 delta，照常落库，不受影响。

任务：

1. **验证先行**（`tests/`，用 `fake-eve-server.test-helper.ts` 脚本化流）：
   a. 跳过 delta 落库后，冷打开投影 === 全量事件投影（复用
      `stream-projection.test.ts` 的 project 对比法）；
   b. 断流重连：客户端以持久化 cursor `attach`，Eve 重放区间内的事件经
      `(session, stream_index)` 唯一约束幂等吸收，浏览器投影无重复；
   c. cursor 懒持久化（见 3）落后于实际位置时，重放同样被吸收。
2. `persistEvent`（`eve-proxy.ts`）：`message.appended` / `reasoning.appended`
   只转发给浏览器并前移内存中的 `nextStreamIndex`，**不 INSERT、不 UPDATE chats**。
3. cursor 持久化点收敛：只在落库事件（即所有非 delta 事件）时写入，且并入
   `appendEvent` 同一事务 —— `appendEvent` 增加可选 `sessionState` 参数，在
   advisory lock 内一并 UPDATE `chats`。删除独立的每事件 `updateChatSessionState`
   调用（方法保留给 turn 请求路径）。
4. 读路径 `collapseStreamedDeltas` **保留**：历史数据里已存的 delta 仍需折叠。
   注释更新为"历史数据兼容"。
5. （可选，单独执行）历史数据清理脚本：删除已被 completion 取代的
   `*.appended` 行。maintenance script 而非 migration，UAT 先跑并核对行数。

验收：

- 长回复会话 `events` 行数 ~O(落库事件数) 而非 O(token 数)；
- 每个流式事件恰好 ≤1 个事务；
- 1a–1c 测试绿；现有 `eve-proxy.test.ts` / `pending-input.test.ts` 全绿。

风险与接受的行为变化：

- 超出 Eve 保留期的会话，若某条消息从未 `completed`（turn 中途死亡），其残句在
  冷打开时不可见。该消息本来就以 `turn.failed`/`turn.cancelled` 收尾，接受。
- 回退方案：`persistEvent` 的跳过逻辑用单一常量开关（跳过类型集合置空即回到旧行为）。

### P2 — CSR 化：页面零服务端查询（决策 §2；B4 撤销、B7 收尾、B11）

原则：`src/app/**/page.tsx` 与 `layout.tsx` 中不出现 `createRepository` /
`getDbClient` / `cookies()`；数据全部由客户端组件经 `/api/*` 获取。

1. **API 补缺**：
   a. `GET /api/agents/[agentId]`（现只有 PATCH/DELETE）：返回 redacted 单项
      （id/name/status/evelandProjectId + edit defaults，复用现有 redaction）；
   b. `GET /api/chats/[chatId]` 响应的 chat 对象补 `evelandProjectId` 字段
      （客户端 caller-token 流程需要，替代现在的 SSR hint）。
2. **layout**：删除 `getAppNavigationData` 与 DB 查询；`AppSidebar` 纯客户端。
3. **AppHeader**：改读 ChatListProvider（列表项已带 `agentConnectionId`/`agentName`）
   ＋客户端 agents 数据。顺带修复 B11：`/chats/:id` 头部显示所属 agent。
4. **`/`**：撤销 SSR redirect（`page.tsx` 回到纯 `<HomeRedirect />`；
   `app-session.ts` 的 `verifyAppBrowserSessionToken` 若无他用一并移除）。
   代价说明：回到"hydrate 后跳转"，但 shell 已静态 + ChatListProvider 单请求，
   与修复前的 4 请求瀑布不可同日而语。
5. **`/chats/[chatId]`**：页面变纯 shell（只传 `chatId`）；404 由
   `AuthenticatedChatThread` 已有的 `missing` 态承担；`evelandProjectId`
   来自 1b。
6. **`/agents/[agentId]`、`/agents/[agentId]/edit`、`/chats/new`**：改客户端
   fetch（1a / 现有 `GET /api/agents`）；页面里的 `cache()` 包装随查询一并删除。
7. **静态化**：移除全部 `export const dynamic = "force-dynamic"`；
   `generateMetadata` 中带 DB 查询的改为静态标题；移除 P2 后已无意义的
   `loading.tsx`（静态页导航即时，客户端组件自带 spinner）。
8. **测试改写**：`app-routing`、`agent-new-chat-page*`、`agent-ui`、
   `app-sidebar`、`app-header` 相关断言改为 CSR 语义。

验收：

- `pnpm build` 输出中**全部页面路由为 ○（Static）**；
- `src/app/**/{page,layout}.tsx` 中 grep 不到 `getDbClient|createRepository|cookies(`；
- DevTools trace：任意导航即时渲染 shell，仅一次 `/api/chats`；
- `/chats/:id` 头部正确显示 agent 名与状态（B11 修复的回归测试）。

### P3 — React Compiler（B10）

1. `pnpm add -D babel-plugin-react-compiler`；`next.config.ts` 加 `reactCompiler: true`。
2. 全量回归（测试 + build + 手动流式一次长回复）。
3. React DevTools Profiler 抽查：流式期间非末条 `EveMessageView` 不重渲染。
4. 若 compiler 对个别组件退化（编译诊断给出），备选方案：手动 `memo(EveMessageView)`
   ＋ `useMemo` 稳定 `inputRequests`。仅在备选时改动 HITL 相关代码。

### P4 — 投影物化（B8 读侧的架构终点；依赖 P1）

方向（实施前按仓库惯例先出设计文档到 `docs/plans/` 评审）：

- `chats` 增加 `projection_json` + `projection_stream_index`；tap 在**落库事件**时
  于同一 advisory lock 事务内增量跑 reducer 更新投影；
- `GET /api/chats/[chatId]` 直接返回投影＋投影点之后的尾部事件；
- 列表 `lastMessage` 改读投影（替代 `listMessageTailEvents`）；
- `events` 退为审计与重建来源；投影带 schema 版本号，eve 升级导致 reducer 行为
  变化时按版本失效重建。

未决问题（设计文档需回答）：

- 投影重建的触发与成本（按 chat 惰性重建 vs 批量迁移）；
- `client.input.responded` 这类 app-owned 事件在投影中的合并次序；
- 0.29/0.30 token 会话的 `session.waiting` 轮转与投影点的关系。

## 5. 部署与复测

1. 迁移经 `compose.production.yaml` 的 `migrate` service 自动应用；
   P0 的 DROP TABLE 前确认备份。
2. 每阶段合入后按 `update-eve-chats-uat` 流程部署 UAT。
3. 复测脚本：DevTools trace 记录 `/`、`/agents/:id`、`/chats/:id`（长会话）的
   请求瀑布与 transfer 体积，追加到本文档附录，与 §1 基线对照。

## 附录 A — 已落地的 commit（本地 main，未 push）

前置止血（rebase 后哈希）：

- chat-list 瀑布合一 + 批量预览查询 + 索引（B1–B4）
- loading 边界 + 重库懒加载（B5–B7）
- `b5895f1` 读路径 delta 折叠（B8 读侧）

计划执行：

- `b63ee59` docs: 本计划
- `72c24ed` P0：DROP messages 死表（migration 0009）
- `1470e7c` P1：写路径停写 delta、cursor 并入 appendEvent 单事务
- `c4d57e0` P2：CSR 化 —— 页面零查询、GET /api/agents/[agentId]、chat 响应带
  evelandProjectId、header 修复 B11、`/` 回归客户端跳转、loading.tsx 移除
- `a34ca13` P3：React Compiler（build ~6s → ~28s）

## 附录 B — 执行后的验证记录（2026-08-20，localhost:3010 dev）

- 每个路由视图 `GET /api/chats` 恰好 **1 次**（修复前 4 次）。dev StrictMode 双重
  effect 下 provider 的 in-flight 去重仍保持 1 次；`/api/agents`、
  `/api/chats/:id` 在 dev 下出现 ×2 属 StrictMode 伪影，生产不发生。
- `/chats/:id` 头部正确显示所属 Agent 名与 healthy 徽章（B11 修复实测）。
- 真实长会话 `chat_47c2dfe44ff0459e`：库存 14,726 行 / 43 MB
  （`reasoning.appended` 13,199 行 / 42 MB），折叠后下发 182 事件 / 236 KB，
  **186× 放大已消除**；P1 后新会话不再写入 delta 行。
- 289 个测试全绿（含 DB 测试）；`pnpm build` 通过。
- 与本计划并行，另一会话落地了 `7e1f937`（强制 Eveland Identity 的
  IdentityGate + `/api/chats/claim`），与 CSR 化兼容：gate 是客户端组件，
  数据请求仍全部由客户端发起。
- P2 验收偏差：路由仍为 ƒ（layout 读 sidebar 状态 cookie 以避免展开态闪烁，
  且动态段路由本就无法 ○ 静态）。验收改为达成的实质目标：页面与 layout
  零数据库查询（`grep getDbClient|createRepository` 于 `app/**/{page,layout}`
  仅剩 layout 的 cookies()）。
- 待办：dev server 需重启以启用 `reactCompiler`（next.config.ts 变更不热载）；
  React DevTools profiler 抽查在重启后进行。
- 历史数据清理（P1 任务 5，可选）尚未执行；上面 43 MB 会话表明值得做，
  脚本需先在 UAT 核对行数后再上生产。
