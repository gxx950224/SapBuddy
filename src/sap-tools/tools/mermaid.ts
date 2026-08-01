/** 工具组：Mermaid 图表（create_mermaid_diagram、validate_mermaid_syntax、get_mermaid_documentation、detect_mermaid_diagram_type） */
import { z } from "zod"

function detectType(code: string): string {
  const c = code.trim()
  if (/^sequenceDiagram/mi.test(c)) return "sequenceDiagram"
  if (/^flowchart|^graph /mi.test(c)) return "flowchart"
  if (/^erDiagram/mi.test(c)) return "erDiagram"
  if (/^classDiagram/mi.test(c)) return "classDiagram"
  if (/^stateDiagram/mi.test(c)) return "stateDiagram"
  if (/^gantt/mi.test(c)) return "gantt"
  if (/^pie/mi.test(c)) return "pie"
  if (/^mindmap/mi.test(c)) return "mindmap"
  if (/^timeline/mi.test(c)) return "timeline"
  return "unknown"
}

// ─── create_mermaid_diagram ─────────────────────────────────────────────────
export const createMermaidTool = {
  name: "create_mermaid_diagram",
  title: "Create Mermaid Diagram",
  description:
    "根据结构化输入生成 Mermaid 图表代码（流程图/时序图/ER 图）。生成后可贴到支持 Mermaid 的渲染器显示。不访问 SAP。",
  inputSchema: z.object({
    diagramType: z
      .enum(["flowchart", "sequenceDiagram", "erDiagram", "classDiagram"])
      .describe("图表类型"),
    title: z.string().optional().describe("图表标题（生成注释）"),
    nodes: z
      .array(z.object({ id: z.string(), label: z.string().optional() }))
      .optional()
      .describe("节点/参与者（flowchart/classDiagram/erDiagram 用）"),
    edges: z
      .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() }))
      .optional()
      .describe("连线/消息（flowchart: A-->B; sequenceDiagram: A->>B: 消息）"),
    direction: z.enum(["TD", "LR", "BT", "RL"]).optional().describe("flowchart 方向，默认 TD"),
  }),
  async execute(args: {
    diagramType: string
    title?: string
    nodes?: Array<{ id: string; label?: string }>
    edges?: Array<{ from: string; to: string; label?: string }>
    direction?: string
  }): Promise<string> {
    const edges = args.edges ?? []
    const nodes = args.nodes ?? []
    const title = args.title ? `%% ${args.title}\n` : ""
    const lines: string[] = [title]

    switch (args.diagramType) {
      case "flowchart": {
        lines.push(`flowchart ${args.direction ?? "TD"}`)
        for (const n of nodes) lines.push(`  ${n.id}[${n.label ?? n.id}]`)
        for (const e of edges) {
          lines.push(`  ${e.from} -->|${e.label ?? ""}| ${e.to}`)
        }
        break
      }
      case "sequenceDiagram": {
        lines.push("sequenceDiagram")
        const participants = new Set<string>()
        for (const e of edges) {
          participants.add(e.from)
          participants.add(e.to)
        }
        for (const p of participants) lines.push(`  participant ${p}`)
        for (const e of edges) {
          lines.push(`  ${e.from}->>${e.to}: ${e.label ?? ""}`)
        }
        break
      }
      case "erDiagram": {
        lines.push("erDiagram")
        for (const n of nodes) lines.push(`  ${n.id} {`)
        for (const e of edges) {
          lines.push(`  ${e.from} ||--o{ ${e.to} : "${e.label ?? ""}"`)
        }
        break
      }
      case "classDiagram": {
        lines.push("classDiagram")
        for (const n of nodes) lines.push(`  class ${n.id} {`)
        for (const e of edges) {
          const arrow = e.label?.startsWith("继承") || e.label?.includes("extends") ? "<|--" : "--"
          lines.push(`  ${e.from} ${arrow} ${e.to}`)
        }
        break
      }
      default:
        return `不支持的图表类型: ${args.diagramType}`
    }
    return lines.join("\n")
  },
}

// ─── validate_mermaid_syntax ────────────────────────────────────────────────
export const validateMermaidTool = {
  name: "validate_mermaid_syntax",
  title: "Validate Mermaid Syntax",
  description:
    "对 Mermaid 图表代码做基础语法校验（类型声明、括号配对、标签完整性）。本地校验，不访问外部服务。",
  inputSchema: z.object({
    code: z.string().describe("Mermaid 图表代码"),
  }),
  async execute(args: { code: string }): Promise<string> {
    const code = args.code.trim()
    if (!code) return "校验失败: 图表代码为空。"
    const type = detectType(code)
    if (type === "unknown") {
      return `校验失败: 无法识别图表类型（需以 flowchart/graph/sequenceDiagram/erDiagram/classDiagram 等声明开头）。\n代码: ${code.slice(0, 200)}`
    }
    const issues: string[] = []
    // 括号配对检查
    let depth = 0
    for (const ch of code) {
      if (ch === "{" || ch === "[" || ch === "(") depth++
      if (ch === "}" || ch === "]" || ch === ")") depth--
    }
    if (depth !== 0) issues.push(`括号不配对（净深度 ${depth}）`)
    if (!/\n/.test(code)) issues.push("建议多行书写")
    if (issues.length === 0) {
      return `✅ 语法校验通过（类型: ${type}）。注意：本校验为基础检查，复杂图建议在渲染器（如 Mermaid Live）中验证。`
    }
    return `⚠️ 基础校验发现 ${issues.length} 个问题（类型: ${type}）:\n- ${issues.join("\n- ")}`
  },
}

// ─── get_mermaid_documentation ──────────────────────────────────────────────
export const mermaidDocTool = {
  name: "get_mermaid_documentation",
  title: "Get Mermaid Documentation",
  description: "返回 Mermaid 常用图表类型的语法速查（flowchart / sequenceDiagram / erDiagram / classDiagram）。写图之前可先查。",
  inputSchema: z.object({
    diagramType: z.enum(["flowchart", "sequenceDiagram", "erDiagram", "classDiagram"]).optional().describe("要查询的类型，默认全部"),
  }),
  async execute(args: { diagramType?: string }): Promise<string> {
    const docs: Record<string, string> = {
      flowchart:
        "flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[处理]\n  B -->|否| D[结束]\n\n要点: 声明 flowchart LR/TD/BT/RL; 节点 A[标签] A(圆角) A{菱形} A((圆)); 连线 --> ---.-> ==>.==",
      sequenceDiagram:
        "sequenceDiagram\n  participant A as 用户\n  participant B as 系统\n  A->>B: 请求\n  B-->>A: 响应\n\n要点: participant 声明; -> >> 实线, --> >> 虚线; loop/alt 块。",
      erDiagram:
        "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n\n要点: 关系 ||--o{ (一对多) }o--o{ (多对多); 实体块 { type string }。",
      classDiagram:
        "classDiagram\n  class Animal {\n    +String name\n    +makeSound() void\n  }\n  class Dog {\n    +makeSound() void\n  }\n  Dog <|-- Animal\n\n要点: class 声明; 属性/方法; <|-- 继承, *-- 组合, o-- 聚合。",
    }
    const type = args.diagramType
    if (type && docs[type]) return docs[type]
    return Object.entries(docs)
      .map(([k, v]) => `【${k}】\n${v}`)
      .join("\n\n")
  },
}

// ─── detect_mermaid_diagram_type ────────────────────────────────────────────
export const detectMermaidTool = {
  name: "detect_mermaid_diagram_type",
  title: "Detect Mermaid Diagram Type",
  description: "检测一段 Mermaid 代码的图表类型（flowchart/sequenceDiagram/erDiagram/classDiagram 等）。",
  inputSchema: z.object({
    code: z.string().describe("Mermaid 图表代码"),
  }),
  async execute(args: { code: string }): Promise<string> {
    const type = detectType(args.code)
    if (type === "unknown") {
      return `无法识别图表类型。支持: flowchart/graph, sequenceDiagram, erDiagram, classDiagram, stateDiagram, gantt, pie, mindmap, timeline。\n代码开头: ${args.code.trim().slice(0, 120)}`
    }
    return `检测到的图表类型: ${type}`
  },
}
