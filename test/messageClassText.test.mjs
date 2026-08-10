/**
 * translate_message_class 消息类翻译工具单测
 * 覆盖：消息号归一化、消息类名校验、copy/set 模式生成的 ABAP 源码结构（T100 写 + 自检回滚）
 * 语言键：现在一律先解析到 lv_tgt/lv_src 变量（VI 等特殊键从 T002 反查），源码里不再直接嵌语言键字面量
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { normalizeMsgNumber, isValidMsgClass, generateClassSource } = require("../dist/sap-tools/tools/messageClassText.js")
const { resolveLanguageSpec } = require("../dist/sap-tools/tools/languageKeys.js")

test("normalizeMsgNumber：1~3 位数字补零为 3 位", () => {
  assert.equal(normalizeMsgNumber("1"), "001")
  assert.equal(normalizeMsgNumber("01"), "001")
  assert.equal(normalizeMsgNumber("001"), "001")
  assert.equal(normalizeMsgNumber("999"), "999")
  assert.equal(normalizeMsgNumber(" 5 "), "005")
})

test("normalizeMsgNumber：非法输入返回 null", () => {
  assert.equal(normalizeMsgNumber("1234"), null)
  assert.equal(normalizeMsgNumber("abc"), null)
  assert.equal(normalizeMsgNumber("12a"), null)
  assert.equal(normalizeMsgNumber(""), null)
})

test("isValidMsgClass：合法类名（含小写自动视为合法）", () => {
  assert.equal(isValidMsgClass("ZFI001"), true)
  assert.equal(isValidMsgClass("zfi001"), true)
  assert.equal(isValidMsgClass("Z_MSG_CLS"), true)
})

test("isValidMsgClass：非法类名", () => {
  assert.equal(isValidMsgClass("BAD-NAME"), false)
  assert.equal(isValidMsgClass("HAS SPACE"), false)
  assert.equal(isValidMsgClass("TOO_LONG_123456789012345678901"), false)
  assert.equal(isValidMsgClass(""), false)
})

test("isValidMsgClass：copy 模式允许 % 通配", () => {
  assert.equal(isValidMsgClass("ZFI%", true), true)
  assert.equal(isValidMsgClass("ZFI*", true), true)
  assert.equal(isValidMsgClass("ZFI%", false), false)
})

// ── 语言键解析（languageKeys）──────────────────────────────
test("resolveLanguageSpec：标准键与中文名", () => {
  assert.deepEqual(resolveLanguageSpec("E"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("1"), { kind: "literal", char: "1" })
  assert.deepEqual(resolveLanguageSpec("D"), { kind: "literal", char: "D" })
  assert.deepEqual(resolveLanguageSpec("英文"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("中文"), { kind: "literal", char: "1" })
  assert.deepEqual(resolveLanguageSpec("EN"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("ZH"), { kind: "literal", char: "1" })
})

test("resolveLanguageSpec：越南语 VI → ISO 反查；V 是瑞典语不是越南语", () => {
  assert.deepEqual(resolveLanguageSpec("VI"), { kind: "iso", code: "VI" })
  assert.deepEqual(resolveLanguageSpec("越南"), { kind: "iso", code: "VI" })
  assert.deepEqual(resolveLanguageSpec("越南语"), { kind: "iso", code: "VI" })
  // V 只是普通单字符 → literal（瑞典语 SV），绝不能被当作越南语
  assert.deepEqual(resolveLanguageSpec("V"), { kind: "literal", char: "V" })
})

test("resolveLanguageSpec：无法识别返回 null", () => {
  assert.equal(resolveLanguageSpec(""), null)
  assert.equal(resolveLanguageSpec(undefined), null)
  assert.equal(resolveLanguageSpec("   "), null)
})

// ── copy 模式 ──────────────────────────────────────────────
test("copy 模式：语言键解析为 lv_src/lv_tgt，INSERT/MODIFY + 自检回滚", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "copy", {
    messageClass: "ZFI001",
    srcLang: "E",
    tgtLang: "VI",
  })
  assert.ok(src.includes("lv_src = 'E'."), "源语言应解析为字面量 E")
  assert.ok(src.includes("SELECT SINGLE spras FROM t002 INTO @lv_tgt WHERE laiso = 'VI'."), "VI 应从 T002 反查真实键")
  assert.ok(src.includes("IF sy-subrc <> 0. out->write( 'LANG-NOTFOUND:VI' ). RETURN. ENDIF."), "反查失败应中止")
  assert.ok(src.includes("WHERE arbgb LIKE 'ZFI001' AND sprsl = @lv_src"), "应按 lv_src 读取源语言")
  assert.ok(src.includes("ls_t100-sprsl = lv_tgt."), "目标行应写入 lv_tgt")
  assert.ok(src.includes("INSERT t100 FROM ls_t100."), "目标行不存在应 INSERT")
  assert.ok(src.includes("MODIFY t100 FROM ls_t100."), "目标行已存在应 MODIFY")
  assert.ok(src.includes("SELECT SINGLE * FROM t100"), "应重读核对自检")
  assert.ok(src.includes("sprsl = @lv_tgt"), "自检应按 lv_tgt 核对")
  assert.ok(src.includes("ROLLBACK WORK."), "自检失败应回滚")
  assert.ok(src.includes("COMMIT WORK."), "自检通过才提交")
})

test("copy 模式：语言键不在源码里直接嵌乱码字符", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "copy", {
    messageClass: "ZFI001",
    srcLang: "E",
    tgtLang: "VI",
  })
  assert.ok(!src.includes("sprsl = '"), "不得再直接嵌语言键字面量到 sprsl")
})

// ── set 模式 ───────────────────────────────────────────────
test("set 模式：按 [{msgNumber,text}] 写入 lv_tgt 语言 + 逐条自检", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "set", {
    messageClass: "ZFI001",
    tgtLang: "V",
    texts: [
      { msgNumber: "001", text: "单据已过账" },
      { msgNumber: "002", text: "金额不能为空" },
    ],
  })
  assert.ok(src.includes("lv_tgt = 'V'."), "目标语言应解析为字面量变量")
  assert.ok(src.includes("ls_t100-arbgb = 'ZFI001'."), "应写消息类名")
  assert.ok(src.includes("ls_t100-msgnr = '001'."), "应写消息号 001")
  assert.ok(src.includes("ls_t100-msgnr = '002'."), "应写消息号 002")
  assert.ok(src.includes("ls_t100-sprsl = lv_tgt."), "应写 lv_tgt 语言")
  assert.ok(src.includes("ls_t100-text = '单据已过账'."), "应写中文文本")
  assert.ok(src.includes("INSERT t100 FROM ls_t100."), "应 INSERT")
  assert.ok(src.includes("MODIFY t100 FROM ls_t100."), "应 MODIFY")
  assert.ok(src.includes("SELFCHECK-FAIL:001"), "应核对消息 001 文本一致")
  assert.ok(src.includes("SELFCHECK-FAIL:002"), "应核对消息 002 文本一致")
  assert.ok(src.includes("ROLLBACK WORK."), "任一核对失败应整体回滚")
})

test("set 模式：文本中的单引号应转义为 ABAP 双单引号", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "set", {
    messageClass: "ZFI001",
    tgtLang: "V",
    texts: [{ msgNumber: "001", text: "O'Brien 单据" }],
  })
  assert.ok(src.includes("ls_t100-text = 'O''Brien 单据'."), "单引号应转义")
})

test("set 模式：无消息时只生成框架不生成 INSERT", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "set", {
    messageClass: "ZFI001",
    tgtLang: "V",
    texts: [],
  })
  assert.ok(!src.includes("INSERT t100"), "空消息列表不应生成 INSERT")
  assert.ok(src.includes("写入完成"), "仍应输出完成统计")
})
