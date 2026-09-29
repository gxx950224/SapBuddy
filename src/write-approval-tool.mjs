import { Type } from "typebox"

// Request approval before any SAP write is attempted. The write gate remains
// authoritative: this tool only presents a confirmation card and ends the turn.
export function registerWriteApprovalTool(pi, onRequest) {
  pi.registerTool({
    name: "request_write_approval",
    label: "申请写入确认",
    description: "代码写入前调用。先在回复中展示改动计划，再将覆盖全部改动的 unified diff 传入本工具；页面会在计划后以差异视图展示 diff 和最终确认弹窗。不要在回复中重复粘贴同一份 diff。未确认前不要调用写工具。此工具不授权、不修改 SAP。",
    promptSnippet: "所有代码修改：先在回复中展示计划，再用 request_write_approval 提交完整 unified diff（旧行 -、新行 +、上下文行），由页面展示差异和确认弹窗。不要在回复中重复 diff；收到确认前不要调用写工具。",
    parameters: Type.Object({
      objectName: Type.String({ minLength: 1, maxLength: 160 }),
      summary: Type.String({ minLength: 1, maxLength: 1200 }),
      diff: Type.String({ minLength: 1, maxLength: 60000, description: "覆盖本次所有拟改动对象的 unified diff；创建对象用 /dev/null 作为旧文件" }),
    }),
    async execute(toolCallId, args) {
      if (!/^@@\s/m.test(args.diff) || !/^[+-](?![+-])/m.test(args.diff)) {
        return { content: [{ type: "text", text: "请先生成包含 @@ 区块及 +/- 改动行的完整 unified diff，再申请写入确认。" }], details: {}, isError: true }
      }
      onRequest?.({ toolCallId, toolName: "request_write_approval", input: {
        name: args.objectName,
        summary: args.summary,
        diff: args.diff,
      }, preflight: true })
      return { content: [{ type: "text", text: JSON.stringify({
        status: "awaiting_user", instruction: "写入确认卡片已展示。结束本轮，等待用户明确确认；此时尚未授权或执行写入。",
      }) }], details: {}, terminate: true }
    },
  })
}
