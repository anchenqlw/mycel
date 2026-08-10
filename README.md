# Mycel

> A local-first living production graph for durable human-agent collaboration.

Mycel 不是一次性工作流生成器，也不是给 Agent 套上一层任务看板。它让 Human Actor、Adopted Worker 与 Native Worker 在一张可版本化、可执行、可审计的 Graph 中形成持续的生产关系。

Conversation is the control surface. The typed graph, SQLite ledger, runs, evidence, permissions, and artifacts are the fact surface.

## 为什么是 Living Production Graph

任务列表只回答“现在要做什么”，一次性工作流只描述“这一次如何跑”。Mycel 保留更长久的事实：谁对什么负责、Worker 使用哪个版本的能力与指令、哪个 Flow 产生了哪次 Run、权限如何授予，以及结果由哪份证据支撑。

你可以用自然语言和 Steward 交谈；但每个持久副作用都会进入类型化、可回放的事实层，而不是藏在一段聊天记录里。

## 产品截图

| 视图 | 你可以看到什么 |
| --- | --- |
| [Steward 对话](./docs/assets/screenshots/steward.png) | 直接回答与需要人确认的 ChangeSet |
| [Living Graph](./docs/assets/screenshots/graph.png) | Actor、Flow、Run、Artifact 与 Permission 在同一张图中 |
| [Workers](./docs/assets/screenshots/workers.png) | Adopted/Native Worker 与版本化 Harness 事实 |
| [Flow Run](./docs/assets/screenshots/flow-run.png) | Human + Worker 协作、等待、证据与恢复状态 |

截图由固定的虚构演示数据生成，不来自开发者的真实对话、账号或本地账本。

## 核心概念

- **Living Production Graph（持续生产图）**：将角色、工作、流程、运行、权限和产物表示为可版本化、可执行的类型化 Graph。
- **Human Actor**：对高风险变更、归属、权限或验收负责的人。
- **Worker**：在明确工作区、能力和权限边界内执行任务的 Agent。**Adopted Worker** 是 Mycel 纳管的本机 Claude Code/Codex CLI 或已注册外部 Worker；**Native Worker** 由 Mycel 创建，其指令、工具、技能、文件和委派边界由不可变版本描述。
- **Steward**：对话中的协调器。它区分普通问答、需要澄清的请求和需要持久变更的意图。
- **Workspace**：经服务端解析和校验的本地仓库、目录或隔离 worktree，是 Worker 可操作的边界。
- **Worker Harness / WorkerSpecVersion**：Harness 是会话实际收到的系统指令、工具、技能、MCP、文件、预算和委派限制；WorkerSpecVersion 是这套配置的不可变版本。
- **Work / Task / Attempt / Session**：Work 是 Graph 中持续的工作事实；Task 是可分配、可验收的执行单元；Attempt 是 Task 的一次尝试；Worker Session 是该 Attempt 与本机或外部 Worker 适配器之间的受控执行会话。
- **Flow / FlowVersion / Run**：Flow 是可重复发布的 Human + Worker 有向无环图（DAG）；FlowVersion 是它的不可变发布版本；Run 是某个 FlowVersion 的一次固定执行。Run 由 Step 构成，其中 Human Task 是需要人领取并提交结果的 Step。
- **ChangeSet / Command**：ChangeSet 是对 Graph 的可审批、可验证持久变更；Command 是对已存在对象的运行时控制。
- **Permission lease（权限租约）**：一次 Attempt 获得的最小、有时效授权；超出 Flow 上限的请求必须等待 Human Actor 处理。
- **Evidence / Artifact**：Evidence 是支撑结果的可验证引用；Artifact 是 Run 产生并连回 Graph 的文件或结构化结果。

## 已实现的功能

- Steward 直接回答普通问题，对模糊请求澄清，对持久副作用生成类型化 ChangeSet。
- 统一 Graph 展示 Actor、Work、Flow、Run、Artifact、Permission 及它们的关系。
- 扫描并纳管本机 Claude Code/Codex CLI，创建 Native Worker，查看版本化 Harness 和 Session 历史。
- 注册、验证并展示 MCP/A2A Worker 的能力契约。
- 发布并重复运行 Human + Worker DAG，支持并行步骤、`all`/`any`/`quorum`/`race` join、重试、容量限制、Human Task 和结构化结果。
- 从 SQLite 账本恢复 Run、Step、Attempt、Human Task、Result 和 Lease，避免已完成副作用重放。
- 在隔离的 Git 分支和 worktree 中执行获批工作，记录 patch、测试报告、摘要和 SHA-256 证据。
- 浏览 Workspace 文件、预览常见文本格式，并按因果链过滤 History。
- Web、钉钉应用机器人 Stream 与飞书通道共享本地事实层；外部 IM 为可选配置。

## 五分钟本地运行

前置条件：Node.js 22.5 或更高版本、Git，以及已安装并登录的 Claude Code CLI。Codex CLI 是可选 Worker。Mycel 从本机 `PATH` 发现 Claude Code 和 Codex，不会代替你安装或登录提供商 CLI。

1. 在仓库根目录安装锁定的依赖：

   ```bash
   npm ci
   ```

2. 复制安全默认配置，再创建全新的本地演示仓库和虚构演示数据：

   ```bash
   cp .env.example .env.local
   npm run demo:public-reset
   ```

3. 检查 Node.js、Claude Code、目标 Git 仓库、测试命令和数据目录：

   ```bash
   npm run doctor
   ```

   如果这一步报告阻塞项，先修复再继续。钉钉和飞书凭证不是 Web demo 的启动条件。

4. 启动本地 API 和 Web 工作台：

   ```bash
   npm run dev
   ```

5. 打开终端输出中的本地 Web 地址。需要改用自己的 Git 仓库时，在 `.env.local` 修改目标仓库和数据目录，然后重新运行 `npm run doctor`。请勿对自己的仓库运行会重置演示数据的命令。

## 一次完整的使用路径

1. 在 Steward 中询问仓库状态；这类只读问题会直接回答，不创建变更。
2. 请求一个需要持久保存的 Worker、Flow 或 Graph 变更；Steward 会提出 ChangeSet。
3. 阅读操作、风险和前置条件，然后由 Human Actor 批准或拒绝高风险部分。
4. 启动 Task 或已发布 Flow。Run 固定当时的 FlowVersion、WorkerSpecVersion、Workspace 和权限租约。
5. 在 Now/Workers/Flows 中观察等待、重试、Human Task 和 Worker 结果。
6. 在 Files 查看产物，在 History 沿因果链回放命令、Session、证据和验收。
7. 由负责验收的 Human Actor 确认结果。验收代表认可证据；V1 不会因此自动 merge 或 push。

## 架构

Mycel 的浏览器工作台通过本地 API/SSE 访问应用服务。应用服务将类型化事件追加到 SQLite Ledger，再投影出 Graph、Flow/Run、Task/Session 和 History 视图。Worker 适配器只在分配的 Workspace 和固定 Harness/租约下调用本机 CLI。

包边界、数据流、信任边界、事件溯源和恢复机制见 [架构文档](./docs/ARCHITECTURE.md)。

## 安全边界

- 运行状态默认位于 `.local/mycel`，`.env.local` 和整个 `.local` 都不应提交。
- IM 和 Worker 凭证保存在本地 Secret Store，不写入 Graph、Ledger、截图、固定数据或浏览器响应。
- 文件路径由服务端解析真实路径并检查 Workspace 边界；命令使用 argv 且 `shell: false`。
- 配置远程 Git URL 只记录远程位置，不授权 clone、fetch、pull、push、merge 或删除。
- 已启动的 Worker Session 和 Flow Run 继续使用启动时固定的 Workspace、WorkerSpecVersion 和权限租约。
- 进度 UI 不应暴露思维链、原始 prompt、原始工具事件、文件全文或命令参数。

详细报告方式和开发规则见 [SECURITY.md](./SECURITY.md) 与 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 当前限制

- 这是面向本地体验和架构参考的 V1 demo，不是经过生产安全审计、多租户隔离或高可用验证的服务。
- MCP/A2A Worker 已支持注册、握手验证、能力展示和 Graph 纳管；远程协议执行、凭证配置和对应适配器仍是待完成工作。
- 真实 Claude CLI 执行可能受提供商、登录 Session、进程 I/O 和网络可靠性影响；当前 Claude smoke 不应被视为稳定通过的发布边界。
- 钉钉和飞书提供单人问答与操作通道；IM 群组线程的多人编排尚未实现。
- 高级 Session 操作尚未在所有 Worker 适配器和 UI 中一致提供。
- 验收不会自动将分支合并或 push 到目标仓库；人仍然掌握远程写入权。

## 路线图

1. 补齐 send/interrupt/resume/fork/retry/replace-worker 的跨适配器控制和恢复语义。
2. 完成 MCP/A2A 协议执行适配器和 SecretRef 配置体验。
3. 增加重启、幂等、部分失败修复和长时运行的端到端验证。
4. 在清晰授权下增加可审计的合并与远程交付能力。

## 参与贡献

请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [AGENTS.md](./AGENTS.md)。每个行为变更都需要对应测试；UI 变更还需要从最终用户视角完成本地浏览器验收。请向公开仓库提交 PR，且不要使用真实账号、凭证或本地运行数据作为 fixture。

## License

Apache License 2.0。详见 [LICENSE](./LICENSE)。
