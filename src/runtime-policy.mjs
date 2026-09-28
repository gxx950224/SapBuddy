export function contextBudget(settings = {}, model = {}) {
  const capability = Number(model.contextWindow) || 200_000
  const requested = Number(settings.contextTokens)
  // A saved connection budget overrides registry metadata (custom endpoints may differ).
  const limit = Number.isFinite(requested) && requested >= 8192 && requested <= 2_000_000
    ? requested : capability
  const reserve = Math.min(16_384, Math.floor(limit / 4))
  return { limit, reserve, keepRecent: Math.min(20_000, Math.floor(limit / 3)) }
}
export function runtimeSettings(settings = {}, model = {}) {
  const budget = contextBudget(settings, model)
  return {
    ...settings,
    // SDK uses a strict > comparison; include the boundary token so 80% triggers too.
    compaction: { enabled: true, reserveTokens: budget.limit - Math.ceil(budget.limit * 0.8) + 1, keepRecentTokens: budget.keepRecent },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000,
      provider: { maxRetries: 0, timeoutMs: 120_000, maxRetryDelayMs: 10_000 } },
  }
}
export function budgetedModel(settings, model) {
  if (!model) return model
  const { limit, reserve } = contextBudget(settings, model)
  return { ...model, contextWindow: limit, maxTokens: Math.min(model.maxTokens || reserve, reserve) }
}

/** Optional discovery mode keeps a stable small tool set until SAP is actually needed. */
export function installToolDiscovery(pi, settings = {}) {
  if (settings.toolProfile !== "discover") return
  let expanded = false
  pi.registerTool({
    name: "enable_sap_tools", label: "启用 SAP 工具",
    description: "需要 SAP/ABAP 对象搜索、源码、表数据、修改激活、传输、文本翻译或质量检查时，先调用本工具启用完整 SAP 工具集。启用后本会话保持可用。",
    parameters: { type: "object", properties: {} },
    async execute() {
      expanded = true
      pi.setActiveTools(pi.getAllTools().map(t => t.name))
      return { content: [{ type: "text", text: "SAP 工具已启用；仍只允许当前连接，写操作继续受授权和开发客户端检查。" }], details: {} }
    },
  })
  const select = () => {
    if (expanded) return
    // Third-party tools and the read/write gate remain intact.
    const sapNames = new Set(settings.sapToolNames || [])
    pi.setActiveTools(pi.getAllTools().map(t => t.name).filter(name => !sapNames.has(name)))
  }
  pi.on("session_start", select)
  pi.on("before_agent_start", select)
}

export function installModelBudget(pi, settings) {
  const apply = async (_event, ctx) => {
    if (!ctx.model) return
    const next = budgetedModel(settings, ctx.model)
    if (next.contextWindow !== ctx.model.contextWindow || next.maxTokens !== ctx.model.maxTokens) await pi.setModel(next)
  }
  pi.on("session_start", apply)
  pi.on("model_select", apply)
}
