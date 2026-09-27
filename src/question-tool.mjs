import { Type } from "typebox"

// Questions are persisted as ordinary tool calls, so the Web card survives reloads.
// This tool never approves or executes SAP writes.
export function registerQuestionTool(pi) {
  pi.registerTool({
    name: "ask_user",
    label: "询问用户",
    description: "需要用户澄清需求或选择方案时调用，展示问题和单选卡片。每次只问一个问题，调用后结束本轮，等待用户下一条消息；工具返回不代表用户已回答。写操作授权仍走原有写入门禁，不使用此工具代替授权。",
    promptSnippet: "需要用户选择或补充信息时用 ask_user 展示提问卡片，然后等待下一条用户消息。",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 600 }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 6 }),
      allowCustom: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: JSON.stringify({
        question: args.question, options: args.options, allowCustom: args.allowCustom !== false || !args.options.length,
        status: "awaiting_user", instruction: "问题已展示，尚未收到回答。结束本轮，等待下一条用户消息。",
      }) }], details: {}, terminate: true }
    },
  })
}
