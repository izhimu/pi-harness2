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
  - `peerDependencies` 对 `@earendil-works/pi-coding-agent` 与 `@oh-my-pi/pi-coding-agent` 均设为 `optional`。
- 代码内部使用类型导入适配：优先通过宿主注入的 `ctx` 动态嗅探运行环境。

### 2.2 路径与配置目录自适应
宿主探测规则：
- 检查当前环境存在 `.omp` 或 `~/.omp` ──► 宿主为 `omp`，配置基准目录解析为 `.omp/`。
- 否则检查 `.pi` 或 `~/.pi` ──► 宿主为 `pi`，配置基准目录解析为 `.pi/`。
- 支持环境变量 `PI_HARNESS_HOST_OVERRIDE=pi|omp` 手动锁定。

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
- 会话结束（`session_stop`）或手动 `/harness-reflect` 时：
  - 按记录头 `session.cwd` 精确匹配定位当前会话文件（pi 与 omp 目录编码规则不同，不反推路径编码）。
  - 解析为 `TimelineEvent[]` + `ToolExecutionRecord[]`；超大文件仅读尾部 4MB（近期摩擦优先）。
  - 派生摩擦点：同一工具 `isError ≥ 2` 判定为重试死循环。

### 3.2 Reflector（反思分析引擎）
- **触发机制**：
  - 自动触发：会话结束（`session_stop`），且当次会话存在摩擦事件（如错误数 $\ge 2$）。
  - 手动触发：运行 `/harness-reflect`。
- **分析算法（Harness² Answer-Free 对比分析）**：
  1. 摩擦点聚类：提取报错最多的工具与参数模式。
  2. 决策树分流：
     - 若为高频参数错误 ──► 优先生成 c8 中间件进行参数清洗或报错截断。
     - 若为固定复杂多步流程 ──► 优先生成 c6 Skill 并注入单行触发词。
     - 若为重复违规操作 ──► 提议 c2 Rule。
     - 若为单纯大文本处理 ──► 提议 c7 Python/Node 确定性脚本。
  3. 生成改进提案（`HarnessProposal`）。

### 3.3 SurfaceMgr（支架管理器与防膨胀铁律）
严格执行 Harness² 三大铁律：
1. **Trigger-Line 铁律**：新建或更新 `skills/<name>/SKILL.md` 时，必须同步在 `RULES.md` 或 `SYSTEM.md` 中注册触发句：
   ```markdown
   - When <触发场景>, load the `<name>` skill.
   ```
2. **Anti-Bloat 膨胀上限**：常驻提示词（c1/c2）更新严禁单次超过 15 行；总行数超标时必须淘汰陈旧规则。
3. **确定性隔离**：外部代码生成必须放置在 `scripts/`，并进行语法与安全探测。

### 3.4 Ledger（演进账本）
- 持久化路径：`<baseDir>/harness/ledger.json`。
- 每次应用自改进方案时，记录快照：
  - 变更前后 Diff
  - 动机与关联会话 ID
  - 影响组件类别与文件绝对路径
- 提供 `/harness-rollback <commit-id>`，实现文件原子性撤回。

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
3. **第三阶段 (高阶演化与中间件支持)**：
   - 支持 c8 动态中间件生成（输出过滤钩子）。
   - 支持跨项目全局经验库同步。
