export interface TemporalFeatureFlags {
  temporalRead: boolean;
  evidenceLayer: boolean;
  temporalHardFilter: boolean;
  agentMessageTimestamps: boolean;
}

export const TEMPORAL_FEATURE_FLAG_ENV = {
  temporalRead: "CONTEXT_ENGINE_TEMPORAL_READ",
  evidenceLayer: "CONTEXT_ENGINE_EVIDENCE_LAYER",
  temporalHardFilter: "CONTEXT_ENGINE_TEMPORAL_HARD_FILTER",
  agentMessageTimestamps: "CONVERSATION_INGESTION_INCLUDE_MESSAGE_TIMESTAMPS"
} as const;

const defaults: TemporalFeatureFlags = {
  temporalRead: true,
  evidenceLayer: true,
  temporalHardFilter: true,
  agentMessageTimestamps: false
};

export function getTemporalFeatureFlags(
  overrides: Partial<TemporalFeatureFlags> = {},
  environment: NodeJS.ProcessEnv = process.env
): TemporalFeatureFlags {
  return {
    temporalRead: overrides.temporalRead
      ?? booleanEnvironmentValue(environment[TEMPORAL_FEATURE_FLAG_ENV.temporalRead], defaults.temporalRead),
    evidenceLayer: overrides.evidenceLayer
      ?? booleanEnvironmentValue(environment[TEMPORAL_FEATURE_FLAG_ENV.evidenceLayer], defaults.evidenceLayer),
    temporalHardFilter: overrides.temporalHardFilter
      ?? booleanEnvironmentValue(environment[TEMPORAL_FEATURE_FLAG_ENV.temporalHardFilter], defaults.temporalHardFilter),
    agentMessageTimestamps: overrides.agentMessageTimestamps
      ?? booleanEnvironmentValue(
        environment[TEMPORAL_FEATURE_FLAG_ENV.agentMessageTimestamps],
        defaults.agentMessageTimestamps
      )
  };
}

export function shouldIncludeConversationMessageTimestamps(
  overrides: Partial<TemporalFeatureFlags> = {}
) {
  return getTemporalFeatureFlags(overrides).agentMessageTimestamps;
}

function booleanEnvironmentValue(value: string | undefined, fallback: boolean) {
  if (value === undefined || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
