# pi-harness2 开发设计方案
> **兼容 Pi 与 oh-my-pi (omp) 双生态的 Harness² 持续自改进、递归支架优化与报告系统**

---

## 1. 项目定位与目标

### 1.1 核心理念
基于 Google [Harness²](https://arxiv.org/abs/2610.14224) 论文架构（Recursive Agent Harnessing for an Open World）：
- 智能体由 **模型权重（Model Weights）+ 支架体系（Harness: 提示词、规则、记忆、工具引导、子代理、技能、脚本、插件中间件）** 构成。
- 模型权重保持冻结，通过**任务级递归（Propose–Probe–Compose）**与**跨会话递归（Experience Reflection）**，实现支架自优化。

### 1.2 目标生态
项目名为 `pi-harness2`，作为统一插件包同构支持两个运行时：
1. **Pi** (`@earendil-works/pi-coding-agent`，配置目录 `.pi` / `~/.pi/agent`)
2. **oh-my-pi (omp)** (`@oh-my-pi/pi-coding-agent`，配置目录 `.omp` / `~/.omp/agent`)

---

## 2. 双宿主兼容架构 (Dual-Host Compatibility)

为确保一套代码在 Pi 与 omp 中无缝运行，系统构建宿主抽象层（Host Adapter）：

```
                  ┌────────────────────────────────────────┐
                  │       pi-harness2 统一扩展核心         │
                  └───────────────────┬────────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
             ┌───────────────────────┐ ┌───────────────────────┐
             │      Pi 运行时        │ │     omp 运行时        │
             │ (.pi / @earendil-...) │ │ (.omp / @oh-my-pi...) │
             └───────────────────────┘ └───────────────────────┘
```

### 2.1 依赖与包名兼容
- `package.json` 声明：
  - `pi.extensions`: `["./extensions"]`
  - `omp.extensions`: `["./extensions"]`
  - `peerDependencies` 对 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 与 `@oh-my-pi/pi-coding-agent` 均设为 `optional`。
  - `devDependencies` 固定真实 SDK 版本，`tsc --noEmit` 始终针对真实宿主 API 编译（不再维护手写 ambient 声明，杜绝 API 幻觉）。
- 代码内部使用类型导入适配：优先通过宿主注入的 `ctx` 动态嗅探运行环境。

### 2.2 路径与配置目录自适应
宿主探测规则（按优先级）：
1. 环境变量 `PI_HARNESS_HOST_OVERRIDE=pi|omp` 手动锁定。
2. 运行时进程信号：`PI_CODING_AGENT` / `AI_AGENT`（pi）、`OMP_PROFILE`（omp）、可执行文件名精确匹配 `omp`（argv 子串匹配会误伤 compose/example 等路径，已弃用）。
3. 项目级目录探测：`.omp/` ──► omp；`.pi/` ──► pi。
4. 用户级探测：仅存在 `~/.omp` ──► omp；`~/.omp` 与 `~/.pi` 并存时，按哪个宿主的 `sessions/` 目录（cwd 编码归一化匹配）实际存在当前项目的录制来消歧；无法判定则默认 pi。
5. 兜底：pi。

### 2.3 8 大组件（c1..c8）在 Pi 与 omp 中的物理映射

| Harness² 组件 | 职责角色 | Pi 宿主路径 | omp 宿主路径 | 加载策略 |
|---|---|---|---|---|
| **c1 System Prompt** | 基础身份与全局流程 | `.pi/SYSTEM.md` | `.omp/SYSTEM.md` | 全局常驻 (极高成本) |
| **c2 Guardrails** | 硬约束与防御规则 | `.pi/rules/*.md` / `RULES.md` | `.omp/rules/*.md` / `RULES.md` | 全局常驻 (高成本) |
| **c3 Memory** | 持久事实与领域知识 | `.pi/agent/memory/` / `LongTermMEMORY.md` | `~/.omp/agent/memory/` | 按会话检索/常驻 |
| **c4 Tool Guidance** | 工具调用说明与避坑 | 工具描述与参数注释 | 工具描述与参数注释 | 工具清单常驻 |
| **c5 Subagents** | 上下文隔离子代理 | `.pi/agents/*.md` | `.omp/agents/*.md` | 按需派发 |
| **c6 Skills** | 标准化领域作业流程 | `.pi/skills/<name>/SKILL.md` | `.omp/skills/<name>/SKILL.md` | **按需触发 (优先推荐)** |
| **c7 Scripts** | 确定性辅助脚本 | `.pi/scripts/*` | `.omp/scripts/*` | 按需执行 (零上下文成本) |
| **c8 Plugins** | 工具循环拦截中间件 | `.pi/extensions/*` | `.omp/extensions/*` | 进程内实时拦截 |

---

## 3. 系统子模块划分

```
pi-harness2/
  ├── SessionReader # 会话记录读取器：解析宿主自身 session JSONL 为时间线
  ├── Reflector     # 反思分析引擎：无监督诊断、失败归因、对比提议
  ├── SurfaceMgr    # 支架管理器：读写与校验 8 类组件，执行 Trigger 校验
  ├── Ledger        # 演进账本：记录 Commit 历史、元数据追踪、一键 Rollback
  └── Reporter      # 报告生成器：终端卡片交互与 Markdown 效能看板
```

### 3.1 SessionReader（宿主会话记录读取）
- **零重复记录铁律**：pi/omp 宿主已将全量会话（user/assistant/toolCall/toolResult，含 `isError`/`durationMs`）落盘于 `<userConfigDir>/sessions/<编码cwd>/<时间戳>_<sessionId>.jsonl`，Harness² 不再自行采集轨迹。
- **增量累计解析**：会话文件为追加写，解析偏移按文件缓存——重复诊断只读新增字节，返回累计事件窗口（上限 4MB 最近内容）；文件缩短/替换时自动重置。每轮触发的读取成本从全量 4MB 降为 KB 级。
- 触发时机（均为宿主真实事件）：
  - `agent_settled`：每轮工作周期结束后做**确定性**诊断（review 模式在此提示用户，不调用 LLM）。
  - `session_shutdown`：会话退出/重载/切换（auto 模式在此应用提案，可用 LLM）。
  - 手动 `/harness-reflect`（可用 LLM）。
- 按记录头 `session.cwd` 精确匹配定位当前会话文件（pi 与 omp 目录编码规则不同，不反推路径编码）；目录解析结果按 `(root, cwd)` 缓存，重复触发只列目标目录。
- 派生摩擦点：同一工具 `isError ≥ 2` 判定为重试死循环，并附带平均耗时（≥5s 标注）。

### 3.2 Reflector（反思分析引擎）
- **触发机制**：
  - 自动触发：`agent_settled`（每轮周期结束）且当次会话存在摩擦事件（如错误数 $\ge 2$）。
  - 手动触发：运行 `/harness-reflect`。
- **LLM 反思通道**：仅在显式触发点（`/harness-reflect`、auto 模式 `session_shutdown`）调用，复用宿主当前模型（`ctx.model` + `@earendil-works/pi-ai` 的 `completeSimple`，宿主进程内解析、密钥随宿主注入）；prompt 设预算（≤300 事件 / 48KB 字符，保留最近事件）；prompt 内置 Harness² 原文的 **Answer-Free** 与 **Evidence-Boundary** 条款；被验证器拒绝的提案将携带拒绝原因回填重试一次；任何环节失败自动降级为确定性诊断。
- **确定性诊断（降级路径，决策树分流）**：
  1. 工具错误聚类（同一工具 ≥ 2 次）──► 生成 c6 Skill（错误摘要经消毒：仅首行、去 Markdown/HTML 语法、限长，防止提示注入持久化）。
  2. 显式用户纠错（强信号正则，中英文）──► 提议 c2 Rule，标记 `autoApplicable=false`（auto 模式下仍需人工审查，避免规则污染）。
  3. 尺寸上限类错误（argument list too long / too large 等 ≥ 2 次）──► 提议 c7 分批执行脚本（`chunked-run-<tool>.sh`，人工审查）。
  4. 单轮工具调用 ≥ 12 次且含 ≥ 2 次错误（上下文过载轮次）──► 提议 c5 批处理子代理（人工审查）。
  5. c8 中间件生成因风险过高明确不做。
- **LLM 路径（Answer-Free 对比分析）**：生成提案与可迁移经验（lessons）；c2/c3 提案与 lesson 的 evidence 均须通过逐条 grounding 校验，未通过即拒绝。

### 3.2.1 经验库（ExperienceLibrary，plugin 版 Library）
- 路径：`<baseDir>/harness/experience/`（每条 lesson 一个 `LESSON-*.md`，`INDEX.md` 从磁盘重建）。
- lesson 采用 Harness² 四字段结构：`cue / lesson / evidence / confidence`，cue 去重、evidence 必须通过 grounding。
- 检索：对当前会话文本做 token 重叠（含 CJK bigram），命中前 3 条注入诊断 prompt 的「Lessons from earlier sessions」段落——知识跨会话累积，而非每次从零诊断。

### 3.2.2 变更效果闭环（plugin 版 Probe）
- 提案应用时记录基线证据（`evidence.tool` + `baselineErrorCount`）。
- 下一次会话即探针：`session_shutdown` 时对「应用时间早于本会话起点」的条目测量——目标工具错误数低于基线为 improved、持平 neutral、超出 regressed；用户重申已应用的规则同样记 regressed。
- **时序安全**：`reason === "reload"` 的 shutdown（会话未结束，如 `/harness-apply` 后的热重载）不测量、不演化、不回滚；`recordOutcome` 以 `measuredSessionStart` 去重，同一会话对同一变更至多计一次；auto 回滚在 `reason === "quit"` 时不触发 reload。
- 连续 2 次 regressed 成为回滚候选：review 模式提示 `/harness-rollback`（同一候选集合只提示一次），auto 模式自动回滚（每次关机最多 3 条）并通知。
- 经验库上限 100 条，超出时淘汰 confidence 最低者（并列取最旧）。

### 3.3 SurfaceMgr（支架管理器与防膨胀铁律）
严格执行 Harness² 三大铁律：
1. **Trigger-Line 铁律**：新建或更新 `skills/<name>/SKILL.md` 时，必须同步在 `RULES.md` 或 `SYSTEM.md` 中注册触发句：
   ```markdown
   - When <触发场景>, load the `<name>` skill.
   ```
   回滚时仅当该次变更真正新增了触发句（`triggerAdded`）或为 CREATE 时才移除注册，避免误删仍被引用的触发句。
   **存量审计（autotrigger 对应物）**：`/harness-report` 扫描未注册触发句的存量技能，从 SKILL.md description 合成触发句并注册（受 200 行上限约束，超限或 frontmatter 不合法则跳过并报告）——未注册的技能是 agent 永远不会调用的死重。
   **frontmatter 卫生**：SKILL.md 缺 `description:`（宿主加载时静默丢弃）或 `name:` 与目录不一致（覆盖目录名导致触发句失配）均在验证时拒绝。
2. **Anti-Bloat 膨胀上限**：常驻提示词（c1/c2）更新严禁单次超过 15 行；规则写入宿主规则文件的**受管段落**（`<!-- pi-harness2:rules:start/end -->`），总行数上限 200 行仅统计受管段落——用户自有内容（如大型 AGENTS.md）不计入、不受影响。c1/c3 另设软上限（SYSTEM.md 8k 字符、memory/ 512KB 或 50 文件），超限在 `/harness-report` 告警。
3. **确定性隔离**：外部代码生成必须放置在 `scripts/`，并进行语法探测（sh/bash `bash -n`、py `ast.parse`、js `node --check`；退出码与 stderr 细节上抛；解释器缺失时跳过）。
4. **安全围栏**：`targetPath` 按组件收窄到对应目录（c6 仅 skills/、c3 仅 memory/、c7 仅 scripts/……），拒绝穿越符号链接的写入（目标文件与规则文件均检查）。

### 3.4 Ledger（演进账本）
- 持久化路径：`<baseDir>/harness/ledger.json`。
- 每次应用自改进方案时，记录快照：
  - 变更前后 Diff
  - 动机与关联会话 ID
  - 影响组件类别与文件绝对路径
  - c6 变更是否新增触发句（`triggerAdded`）与基线证据（`evidence`）
- 效果闭环：每次测量写入 `outcome`（status / samples / consecutiveRegressed / detail），连续 2 次 regressed 触发回滚候选策略（见 3.2.2）。
- 读写经文件锁（`.lock` + 过期自愈）串行化，写入临时文件后原子重命名；条目经结构校验、上限 500 条。
- 提供 `/harness-rollback <commit-id>`，实现文件原子性撤回。
- 演进模式（auto/review）持久化于 `<baseDir>/harness/settings.json`，跨会话生效。

### 3.5 Reporter（分析与报告）
- 命令 `/harness-report`：
  - 输出彩色终端总结（Terminal Card）。
  - 生成详细 Markdown 文件：`<baseDir>/harness/reports/report-<date>.md`。
  - 内容涵盖：健康度雷达、高频失败工具排行榜、组件优化累计增益、Token 开销趋势。

---

## 4. 交互命令设计

| 命令 | 参数 | 说明 |
|---|---|---|
| `/harness-reflect` | `[--deep]` | 立即分析当前会话轨迹并输出 Harness 优化提案 |
| `/harness-report` | `[--json]` | 打印当前项目 Harness 健康度与演进成效报告 |
| `/harness-ledger` | `[limit]` | 查看 Harness 演进历史记录与变更状态 |
| `/harness-rollback`| `<id>` | 回滚指定的历史变更 |
| `/harness-mode` | `<auto\|review>` | 切换为完全自动应用或人工审查确认模式（默认 review） |

---

## 5. 项目目录规范与工程实施

```
pi-harness2/
├── extensions/
│   ├── index.ts             # 扩展入口（兼容 Pi 与 omp 注册逻辑）
│   ├── types.ts             # 跨宿主类型定义
│   ├── host-detector.ts     # 宿主探测与目录路由 (Pi vs omp)
│   ├── session-reader.ts    # 宿主会话记录解析与摩擦派生
│   ├── reflector.ts         # 反思归因引擎
│   ├── surface.ts           # 8 维组件管理与防膨胀约束
│   ├── ledger.ts            # 账本持久化与回滚
│   └── reporter.ts          # 报告渲染器
├── package.json             # 双生态 manifest (pi & omp 配置)
├── tsconfig.json            # 编译配置
├── DESIGN.md                # 本技术设计方案
└── README.md                # 安装使用文档
```

---

## 6. 开发实施三步走计划

1. **第一阶段 (基础兼容与观测)**：
   - 验证 Pi 与 omp 双方的插件加载与命令注册。
   - 实现 SessionReader 解析宿主会话记录，提取工具异常与耗时。
   - 实现 `/harness-report` 基础指标统计。
2. **第二阶段 (反思与账本闭环)**：
   - 实现 Answer-Free Reflector，生成 Skill 与 Rule 改进提案。
   - 实现 SurfaceMgr 的 Trigger 注入校验与 Ledger 存回滚。
   - 实现 `/harness-reflect` 与交互式审批卡片。
3. **第三阶段（已并入 0.3.0，c8 明确不做）**：
   - ~~支持 c8 动态中间件生成（输出过滤钩子）~~——风险收益比不佳，从目标中移除。
   - 跨项目全局经验库同步（`~/.pi|harness/experience` 全局目录）仍为后续方向。
