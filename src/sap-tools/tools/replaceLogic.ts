/** findAndReplace 逻辑（从 abap_fs mcpReplaceStringTool 移植） */
export function findAndReplace(content: string, oldString: string, newString: string): string {
  if (!oldString) {
    if (content.length === 0) return newString
    throw new Error(
      "oldString 不能为空（当前文件非空）。请先用 get_abap_object_lines 读取内容并提供精确的原文。"
    )
  }
  if (oldString === newString) {
    throw new Error("oldString 与 newString 相同，无实际修改。")
  }

  let count = 0
  let idx = 0
  while (true) {
    const i = content.indexOf(oldString, idx)
    if (i === -1) break
    count++
    idx = i + oldString.length
  }

  if (count === 0) {
    const normalizedContent = content.replace(/\r\n/g, "\n")
    const normalizedOld = oldString.replace(/\r\n/g, "\n")
    if (normalizedContent.includes(normalizedOld)) {
      const normalizedNew = newString.replace(/\r\n/g, "\n")
      const updated = normalizedContent.replace(normalizedOld, normalizedNew)
      return content.includes("\r\n") ? updated.replace(/(?<!\r)\n/g, "\r\n") : updated
    }
    throw new Error(
      "未找到指定的 oldString。请用 get_abap_object_lines 读取当前内容，确保文本（含缩进和空白）完全匹配。"
    )
  }
  if (count > 1) {
    throw new Error(
      `oldString 匹配到 ${count} 处，必须唯一。请加入更多上下文行（3-5 行）使匹配唯一。`
    )
  }
  return content.replace(oldString, newString)
}
