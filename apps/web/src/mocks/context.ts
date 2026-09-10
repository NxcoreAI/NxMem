export const mockContextPack = {
  packId: "mock-pack-001",
  profileContext: ["用户偏好：输出要清晰、可解释"],
  taskContext: ["当前任务：Context 引擎脚手架"],
  recentContext: ["最近变化：后端与前端骨架已创建"],
  constraints: ["仅展示脱敏信息"],
  citations: ["memory://mock/1"],
  compressionSteps: [
    {
      id: "mock-item-1",
      action: "compress",
      beforeTokens: 120,
      afterTokens: 42,
      reason: "extractive_compression"
    }
  ]
};
