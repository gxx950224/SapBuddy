/**
 * translate_message_class 消息类翻译工具单测
 * 覆盖：消息号归一化、消息类名校验、copy/set 模式生成的 ABAP 源码结构（T100 写 + 自检回滚）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { normalizeMsgNumber, isValidMsgClass, generateClassSource } = require("../dist/sap-tools/tools/messageClassText.js")

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

test("copy 模式：按源语言 SELECT t100，目标语言 INSERT/MODIFY + 自检回滚", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "copy", {
    messageClass: "ZFI001",
    srcLang: "E",
    tgtLang: "V",
  })
  assert.ok(src.includes("WHERE arbgb LIKE 'ZFI001' AND sprsl = 'E'"), "应 SELECT 源语言 E 的消息")
  assert.ok(src.includes("ls_t100-sprsl = 'V'."), "应把复制行改为目标语言 V")
  assert.ok(src.includes("INSERT t100 FROM ls_t100."), "目标行不存在应 INSERT")
  assert.ok(src.includes("MODIFY t100 FROM ls_t100."), "目标行已存在应 MODIFY")
  assert.ok(src.includes("SELECT SINGLE * FROM t100"), "应重读核对自检")
  assert.ok(src.includes("SELFCHECK-FAIL:{ ls_src-msgnr }"), "核对不上应输出 SELFCHECK-FAIL 消息号")
  assert.ok(src.includes("ROLLBACK WORK."), "自检失败应回滚")
  assert.ok(src.includes("COMMIT WORK."), "自检通过才提交")
})

test("set 模式：按 [{msgNumber,text}] 直接写指定语言 + 逐条自检", () => {
  const src = generateClassSource("ZCL_MSAGTRTEST", "set", {
    messageClass: "ZFI001",
    tgtLang: "V",
    texts: [
      { msgNumber: "001", text: "单据已过账" },
      { msgNumber: "002", text: "金额不能为空" },
    ],
  })
  assert.ok(src.includes("ls_t100-arbgb = 'ZFI001'."), "应写消息类名")
  assert.ok(src.includes("ls_t100-msgnr = '001'."), "应写消息号 001")
  assert.ok(src.includes("ls_t100-msgnr = '002'."), "应写消息号 002")
  assert.ok(src.includes("ls_t100-sprsl = 'V'."), "应写目标语言 V")
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
