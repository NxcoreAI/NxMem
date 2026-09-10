## 1. 契约与测试

- [x] 1.1 为 STM-STM、STM-LTM、LTM-LTM 自动关系边添加失败测试。
- [x] 1.2 为图关系幂等和 Context Pack 冲突消费添加失败测试。

## 2. 图关系模型与服务

- [x] 2.1 扩展 `RelationEdge` 关系类型，补齐 `same_source`、`updates`、`related_to`、`part_of`。
- [x] 2.2 新增 memory graph relation 服务，基于内容、来源、事实、实体和冲突/更新信号生成幂等关系边。

## 3. 流程接入

- [x] 3.1 在 STM 准入写入后维护 STM-STM 和 STM-LTM 图关系。
- [x] 3.2 在 LTM 做梦巩固后维护 LTM derived_from STM 和 LTM-LTM 图关系。

## 4. 验证

- [x] 4.1 运行 targeted 后端测试，确认新增关系功能通过。
- [x] 4.2 运行 OpenSpec 校验和后端 typecheck；完整后端测试按用户要求跳过。
