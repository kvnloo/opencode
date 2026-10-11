// Frozen function extraction from OpenCode base 7b3d4ce3a7dbd2a6d3637722a0d5f22a7d086937.
// These baseline controls pass only filter-only input, so migrateModel is never called.
function migrateProvider(sourceID: string, info: ConfigProviderV1.Info) {
  if (sourceID === "azure-cognitive-services") return migrateAzureCognitiveServicesProvider(info)
  if (sourceID === "google-vertex-anthropic") return migrateGoogleVertexAnthropicProvider(info)
  return migrateStandardProvider(info)
}

function migrateStandardProvider(info: ConfigProviderV1.Info) {
  const options = ConfigProviderOptionsV1.provider(info.options ?? {})
  return {
    name: info.name,
    env: info.env,
    package: info.npm ? Provider.aisdk(info.npm) : undefined,
    settings: info.api ? { ...options.settings, baseURL: info.api } : info.options ? options.settings : undefined,
    headers: info.options && options.headers,
    body: info.options && options.body,
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model)])),
  }
}

function migrateAzureCognitiveServicesProvider(info: ConfigProviderV1.Info) {
  const standard = migrateStandardProvider(info)
  const migrated = {
    ...standard,
    env: standard.env?.filter((name) => name !== "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME"),
  }
  if (info.npm !== "@ai-sdk/openai-compatible" || info.api) return migrated
  return {
    ...migrated,
    settings: {
      ...migrated.settings,
      baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai",
    },
  }
}

function migrateGoogleVertexAnthropicProvider(info: ConfigProviderV1.Info) {
  const migrated = migrateStandardProvider(info)
  const packageName = migrated.package ?? Provider.aisdk("@ai-sdk/google-vertex/anthropic")
  return {
    ...migrated,
    // The current Google Vertex provider includes Gemini and Claude. Keep the Anthropic SDK on Claude models
    // instead of changing the package inherited by every model on the provider.
    package: undefined,
    models:
      migrated.models &&
      Object.fromEntries(
        Object.entries(migrated.models).map(([name, model]) => [
          name,
          model.package ? model : { ...model, package: packageName },
        ]),
      ),
  }
}
