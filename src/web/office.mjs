/**
 * Office 文件文本提取（docx/xlsx/pptx）
 * 零依赖：zip（raw deflate 用 node zlib）+ XML 文本提取
 */
import zlib from "node:zlib"

/** 解析 zip，返回 { name → Buffer }（只解需要的条目按需调用） */
function listZipEntries(buf) {
  // 找 EOCD（End of Central Directory）：文件末尾 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let pos = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break // central directory header
    const method = buf.readUInt16LE(pos + 10) // 0=store, 8=deflate
    const cSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen)
    entries.push({ name, method, cSize, localOffset })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntry(buf, entry) {
  // 解析 local file header 拿数据偏移
  let p = entry.localOffset
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + entry.cSize)
  if (entry.method === 0) return data
  if (entry.method === 8) {
    try {
      const out = zlib.inflateRawSync(data)
      // zip bomb 防护：单个条目解压后超过 100MB 视为异常，丢弃
      if (out.length > 100 * 1024 * 1024) return Buffer.alloc(0)
      return out
    } catch { return Buffer.alloc(0) }
  }
  return Buffer.alloc(0)
}

/** 从 XML 提取文本节点内容（docx <w:t>、pptx <a:t>、xlsx <t>） */
function xmlText(xml) {
  const s = xml.toString("utf8")
  const out = []
  // 匹配 <w:t>...</w:t> / <a:t>...</a:t> / <t>...</t> / <w:t xml:space="preserve">...</w:t>
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g
  let m
  while ((m = re.exec(s)) !== null) out.push(m[1])
  return out.join("")
}

/** 解析 xlsx 工作表 → [{ name, rows: string[][] }]（共享字符串 + 内联字符串 + 数值；空行跳过） */
function parseXlsxSheets(buf) {
  const entries = listZipEntries(buf)
  if (!entries) return null
  // 共享字符串表
  const strings = []
  const ssEntry = entries.find((x) => x.name === "xl/sharedStrings.xml")
  if (ssEntry) {
    const xml = readEntry(buf, ssEntry).toString("utf8")
    const re = /<si>[\s\S]*?<\/si>/g
    let m
    while ((m = re.exec(xml)) !== null) strings.push(xmlText(Buffer.from(m[0])))
  }
  const sheets = entries
    .filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name))
    .sort((a, b) => parseInt(a.name.match(/sheet(\d+)/)[1]) - parseInt(b.name.match(/sheet(\d+)/)[1]))
  const out = []
  for (const e of sheets) {
    const xml = readEntry(buf, e).toString("utf8")
    const rows = []
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = []
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
      let cm
      while ((cm = cRe.exec(rm[1])) !== null) {
        const tAttr = (cm[1].match(/\bt="([^"]+)"/) || [])[1]
        const inner = cm[2]
        let val = ""
        if (tAttr === "s") {
          const idx = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
          const n = idx !== undefined ? parseInt(idx) : -1
          val = n >= 0 && n < strings.length ? strings[n] : ""
        } else if (tAttr === "inlineStr") {
          val = (inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) || [])[1] || ""
        } else {
          val = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ""
        }
        cells.push(val.trim())
      }
      if (cells.length) rows.push(cells)
    }
    out.push({ name: e.name.match(/sheet(\d+)/)?.[1] ?? "?", rows })
  }
  return out
}

/** 提取 Office 文件文本；非 Office 返回 null */
export function extractOfficeText(buf, fileName) {
  const lower = String(fileName || "").toLowerCase()
  const isOffice = /\.(docx|xlsx|pptx)$/.test(lower)
  if (!isOffice) return null
  const entries = listZipEntries(buf)
  if (!entries) return { text: "（无法解析的 Office 文件）", ok: false }

  const parts = []
  if (lower.endsWith(".docx")) {
    const order = ["word/document.xml", "word/header1.xml", "word/footer1.xml", "word/header2.xml", "word/footer2.xml"]
    for (const n of order) {
      const e = entries.find((x) => x.name === n)
      if (e) parts.push(xmlText(readEntry(buf, e)))
    }
    return { text: parts.join("\n\n") || "（文档无正文文本）", ok: parts.length > 0 }
  }
  if (lower.endsWith(".pptx")) {
    const slides = entries.filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.name)).sort((a, b) => {
      const na = parseInt(a.name.match(/slide(\d+)/)[1]), nb = parseInt(b.name.match(/slide(\d+)/)[1])
      return na - nb
    })
    for (const e of slides) {
      const t = xmlText(readEntry(buf, e))
      if (t.trim()) parts.push("【Slide " + (e.name.match(/slide(\d+)/)?.[1] ?? "?") + "】\n" + t.trim())
    }
    return { text: parts.join("\n\n") || "（演示文稿无文本）", ok: parts.length > 0 }
  }
  if (lower.endsWith(".xlsx")) {
    const sheets = parseXlsxSheets(buf)
    if (!sheets) return { text: "（无法解析的 Office 文件）", ok: false }
    for (const s of sheets) {
      const lines = s.rows.map((r) => r.join(" | "))
      if (lines.length) parts.push("【Sheet " + s.name + "】\n" + lines.join("\n"))
    }
    return { text: parts.join("\n\n") || "（工作簿无数据）", ok: parts.length > 0 }
  }
  return { text: "（不支持的 Office 类型）", ok: false }
}
