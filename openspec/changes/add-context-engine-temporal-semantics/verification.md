# 时间语义实现验证记录

## 验证结论

截至 2026-07-25，本 change 的本地实现和验证已完成。共 68 项任务，67 项已完成；仅 `10.5` 生产部署、影子结果检查和 Agent 时间字段灰度未在本地执行。

Agent 时间字段开关 `CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS` 默认保持 `false`。生产环境在完成 PR1 至 PR5 部署、影子差异审查和回滚演练前不得开启。

## 类型检查与定向测试

后端类型检查通过：

```bash
cd apps/backend
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

conversation ingestion、evidence、Fact/STM/LTM temporal、search、Context Pack、session background、backfill 和 rollout 定向测试通过：

```text
tests 118
pass 118
fail 0
```

其中 backfill 与 rollout 收尾测试单独复跑通过：

```text
tests 7
pass 7
fail 0
```

`git diff --check` 通过。

## 全量后端测试

执行：

```bash
cd apps/backend
node --import tsx --test "src/**/*.test.ts"
```

结果：

```text
tests 332
pass 304
fail 28
```

28 个失败均属于已有 LongMemEval core/CLI/API/jobs 测试基线，与本 change 的 temporal schema、fixture 或序列化无关。新增和受影响的 temporal 测试全部通过。

## SQLite 与 backfill

SQLite 文件 repository 已验证：

- 创建并持久化 `context_engine_migrations` migration version、状态、attempt、统计和错误记录；
- 从 extended V3 原始 Markdown 恢复真实 message evidence，并保持 `messageId/createdAt/timezone/locale`；
- legacy V3 仅生成基于 `committedAt` 的 low-confidence evidence，不生成虚假 valid time；
- 重算 Fact、STM、LTM temporal metadata 并刷新索引；
- 数据库重启后恢复消息和 migration 状态；
- 同一已完成 version 重复执行返回原记录，不重复写入；
- 失败 version 可重试，单个 ingestion 失败不会阻断其他 ingestion；
- 关闭 temporal read、evidence layer 或 hard filter 时保留兼容结果并记录 shadow 差异；trace 不包含消息正文。

`temporal-backfill.test.ts` 的 SQLite/幂等/重试验收为 `4/4` 通过。

## 端到端验收

真实扩展 V3 场景已通过：消息时间为 2026-07-23 15:30（`Asia/Shanghai`），内容为“我计划 8 月 1 日从郑州去深圳。”

验收确认：

- message `createdAt` 保持原值；
- Fact evidence time 对应 7 月 23 日消息时间；
- Fact valid time 对应 8 月 1 日；
- `observedAt` 使用实际抽取时间，不参与 evidence/valid 查询；
- valid-basis 和 evidence-basis 查询均可命中；
- Context Pack citation 指向具体 conversation message row，并保留逻辑 `messageId`。

## OpenSpec 校验

以下命令均已尝试，但当前环境未安装 `openspec` CLI：

```bash
openspec status --change add-context-engine-temporal-semantics
openspec status --change add-context-engine-temporal-semantics --json
openspec instructions apply --change add-context-engine-temporal-semantics --json
openspec validate add-context-engine-temporal-semantics
```

命令结果均为：

```text
zsh: command not found: openspec
exit 127
```

因此 artifact 的 CLI 格式校验仍是环境未执行项；本地已人工核对每个 Requirement 均包含 Scenario，任务清单格式符合 OpenSpec 约定。

## 外部发布门禁

以下内容必须在目标环境执行，当前不标记完成：

- 按 `runbook.md` 顺序部署 PR1 至 PR5；
- 显式关闭三个后端 temporal 开关运行生产 shadow；
- 审查 added/removed result IDs、drop reasons、召回差异、延迟和 backfill 失败率；
- 演练关闭 temporal read、evidence layer、hard filter 和 Agent timestamps 的回滚路径；
- 审查通过后仅对小租户 cohort 开启 Agent 时间字段，再逐步扩大灰度。
