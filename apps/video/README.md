# Context Engine 技术演示视频

这是一支 50 秒、1920×1080、30fps 的技术向演示视频，使用 Remotion 代码化生成，内容与仓库当前 Context Engine 规格保持一致。

## 镜头结构

| 时间 | 主题 | 展示重点 |
| --- | --- | --- |
| 00-05s | 开场 | Evidence-first、Graph-aware、Auditable |
| 05-15s | 摄入 | `MemoryEvent`、Data Lake、`FactItem`、`SourceRef`、幂等和审计 |
| 15-25s | STM 准入 | 重要性、置信度、新鲜度、敏感性、冲突和权限门控 |
| 25-35s | 检索 | FTS、Vector、Graph、Time、Feedback 混合排序与关系邻域 |
| 35-43s | Dreaming | 23:00 调度、单 STM 评估、checkpoint、`consolidate / observe / drop` |
| 43-50s | 组装 | Context Pack 的预算、引用、冲突和 dropped reasons |

## 本地使用

```bash
pnpm install
pnpm --filter @nexcore/context-engine-video studio
pnpm --filter @nexcore/context-engine-video render
```

输出文件：`apps/video/out/memory-engine-demo.mp4`

如果需要替换品牌色、客户名称或配音文案，优先修改 `src/MemoryEngineVideo.tsx` 中的 `C` 色板、镜头标题和数据标签。
