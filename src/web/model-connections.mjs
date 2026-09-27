// Build the next configuration before persisting any changes.
export function removeModelConnection(name, modelsConfig, auth, settings) {
  const providers = { ...modelsConfig.providers }
  if (typeof name !== "string" || !Object.hasOwn(providers, name)) {
    throw new Error("要删除的大模型连接不存在")
  }
  delete providers[name]
  const remaining = Object.entries(providers).filter(([, value]) => value?.models?.length)
  if (!remaining.length) throw new Error("请至少保留一个大模型连接；请先添加其他连接再删除")
  const nextAuth = { ...auth }
  delete nextAuth[name]
  const nextSettings = { ...settings }
  if ((settings.defaultProvider ?? "deepseek") === name) {
    const [provider, config] = remaining.find(([id]) => nextAuth[id]?.key) || remaining[0]
    nextSettings.defaultProvider = provider
    const model = config.models[0]
    nextSettings.defaultModel = typeof model === "string" ? model : model.id
  }
  return { models: { ...modelsConfig, providers }, auth: nextAuth, settings: nextSettings }
}
