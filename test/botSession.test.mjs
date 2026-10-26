/**
 * bot session 门禁：不连接真实 SAP。覆盖哈希不一致、源码被他人改过、
 * 错对象、只读配置、非开发客户端，以及提案本身不写 SAP。
 */
import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyEdit,
  assertIdentity,
  BotGateError,
  DEFAULT_PACKAGE_ALLOW,
  diffSha256,
  isSubsetPattern,
  packageMatches,
  parseExpect,
  replayLineDiff,
  resolvePackageAllow,
  sidFromCookies,
  sourceSha256,
  unifiedDiff,
} from "../dist/sap-tools/bot-session/gates.js"
import { bindDeps, executeBotCommand } from "../dist/sap-tools/bot-session/service.js"
import { createSessionStore } from "../dist/sap-tools/bot-session/store.js"
import { runSessionCli } from "../dist/sap-tools/bot-session/cli.js"
import { productionRuntime } from "../dist/sap-tools/bot-session/runtime.js"
import { selectConnectionForOpen } from "../dist/sap-tools/bot-session/connection.js"
import { assertBotWriteAllowed } from "../dist/sap-tools/bot-session/guard.js"
import { __setConfigForTest, getConfig, loadConfig } from "../dist/sap-tools/config.js"
import { resolveConnectionId } from "../dist/sap-tools/tools/shared.js"
import { __setClientFactoryForTest, dropAllClients } from "../dist/sap-tools/adtManager.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SOURCE = "REPORT zdemo.\nWRITE 'OLD'.\nWRITE 'KEEP'."

let dir

function sapConfig({ readOnly = false, allowedPackages, category = "C" } = {}) {
  __setConfigForTest({
    connections: [{
      id: "dev",
      active: true,
      url: "https://fixture.invalid",
      client: "100",
      username: "DEVELOPER",
      password: "secret-password",
      security: { requireDevClient: true, developmentCategories: ["C"] },
    }],
    security: { readOnly, ...(allowedPackages === undefined ? {} : { allowedPackages }) },
  })
  __setClientFactoryForTest(() => ({
    login: async () => {},
    username: "DEVELOPER",
    client: "100",
    dropSession: async () => {},
    runQuery: async () => ({ values: [{ CCCATEGORY: category, MANDT: "100" }] }),
  }))
}

function runtimeFor(state) {
  return {
    async identity(connectionId) {
      state.used.push(connectionId)
      const profile = state.profiles?.[connectionId]
      return {
        connectionId,
        sid: profile?.sid ?? state.sid,
        client: profile?.client ?? state.client,
        user: profile?.user ?? state.user,
      }
    },
    async resolveObject(connectionId, name) {
      state.calls.push("resolve")
      state.used.push(connectionId)
      return { connectionId, object: { ...state.object, name } }
    },
    async readSource(connectionId) {
      state.calls.push("read")
      state.used.push(connectionId)
      return state.sources?.[connectionId] ?? state.source
    },
    async whereUsed() {
      return [{ name: "ZCALLER", type: "PROG/P", usage: "submit" }]
    },
    async syntaxCheck() {
      state.calls.push("syntax")
      return state.syntax ?? []
    },
    async atc() {
      return { available: false, reason: "fixture" }
    },
    async readTable() {
      state.calls.push("table")
      return { columns: ["MANDT"], rows: [{ MANDT: "100" }] }
    },
    async readSql(_connectionId, sql) {
      state.calls.push(`sql:${sql}`)
      return { columns: ["X"], rows: [] }
    },
    async transportStatus() {
      state.calls.push("transport")
      return state.transport
    },
    async objectTransports() {
      return state.objectTransports ?? []
    },
    async writeSource(connectionId, _uri, source, transport) {
      state.calls.push("write")
      state.used.push(connectionId)
      state.writes.push({ source, transport })
      if (state.onWrite) return state.onWrite(source, transport)
      state.source = source
      return { written: true }
    },
    async activate() {
      state.calls.push("activate")
      return state.activateResult ?? { success: true, verification: "matched", messages: ["activated"] }
    },
    async inactiveObjects() {
      state.calls.push("inactive")
      if (state.inactiveError) throw new Error(state.inactiveError)
      return state.inactive ?? []
    },
  }
}

function fixture(patch = {}) {
  const state = {
    sid: "DEV",
    client: "100",
    user: "DEVELOPER",
    object: {
      name: "ZDEMO",
      type: "PROG/P",
      uri: "/sap/bc/adt/programs/programs/zdemo",
      sourceUri: "/sap/bc/adt/programs/programs/zdemo/source/main",
      packageName: "ZPKG",
    },
    source: SOURCE,
    transport: { found: true, status: "D" },
    objectTransports: [],
    calls: [],
    writes: [],
    used: [],
    ...patch,
    object: { ...{
      name: "ZDEMO",
      type: "PROG/P",
      uri: "/sap/bc/adt/programs/programs/zdemo",
      sourceUri: "/sap/bc/adt/programs/programs/zdemo/source/main",
      packageName: "ZPKG",
    }, ...(patch.object ?? {}) },
  }
  const audits = []
  const store = createSessionStore(dir)
  const deps = bindDeps({
    store,
    runtime: runtimeFor(state),
    guard: assertBotWriteAllowed,
    audit: (entry) => audits.push(entry),
    packageCeiling: () => getConfig().security?.allowedPackages,
  })
  return { state, audits, deps }
}

async function openDefault(fx, extra = {}) {
  const result = await executeBotCommand({
    command: "open",
    objectName: "zdemo",
    objectType: "PROG/P",
    transport: "DEVK900123",
    expect: "DEV.100/DEVELOPER",
    ...extra,
  }, fx.deps)
  assert.equal(result.ok, true, result.message)
  return result
}

async function proposeDefault(fx, sessionId, edit) {
  return executeBotCommand({
    command: "propose",
    sessionId,
    edit: edit ?? { mode: "replace", oldString: "WRITE 'OLD'.", newString: "WRITE 'NEW'." },
  }, fx.deps)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sapbuddy-bot-"))
  sapConfig()
  await dropAllClients()
})

afterEach(async () => {
  __setConfigForTest(null)
  __setClientFactoryForTest(null)
  await dropAllClients()
  rmSync(dir, { recursive: true, force: true })
})

test("登录 cookie 只在唯一 SID 时采信", () => {
  assert.equal(sidFromCookies("SAP_SESSIONID_DEV_00=abc"), "DEV")
  assert.equal(sidFromCookies("sap_sessionid_qas_01=abc"), "QAS")
  assert.equal(sidFromCookies("SAP_SESSIONID_DEV_00=a; SAP_SESSIONID_QAS_00=b"), undefined)
  assert.equal(sidFromCookies("other=1"), undefined)
})

test("包允许列表默认 Z* Y*，命令行不能放宽", () => {
  assert.deepEqual(DEFAULT_PACKAGE_ALLOW, ["Z*", "Y*"])
  assert.equal(packageMatches("ZFOO", ["Z*", "Y*"]), true)
  assert.equal(packageMatches("Y_BAR", ["Z*", "Y*"]), true)
  assert.equal(packageMatches("SAPMV45A", ["Z*", "Y*"]), false)
  assert.equal(packageMatches("$TMP", ["Z*", "Y*"]), false)
  assert.equal(isSubsetPattern("ZA*", "Z*"), true)
  assert.equal(isSubsetPattern("Z*", "ZA*"), false)
  assert.equal(isSubsetPattern("*", "Z*"), false)
  assert.deepEqual(resolvePackageAllow(undefined, undefined), ["Z*", "Y*"])
  assert.deepEqual(resolvePackageAllow([], undefined), [])
  assert.throws(() => resolvePackageAllow(["Z*", "Y*"], ["SAP*"]), (err) => err instanceof BotGateError && err.code === "package_allowlist")
  assert.deepEqual(resolvePackageAllow(["Z*", "Y*"], ["ZFOO"]), ["ZFOO"])
})

test("expect 格式与身份比对", () => {
  assert.deepEqual(parseExpect("dev.100/developer"), { sid: "DEV", client: "100", user: "DEVELOPER", text: "DEV.100/DEVELOPER" })
  assert.throws(() => parseExpect("DEV/100"), (err) => err.code === "expect_format")
  assert.throws(
    () => assertIdentity({ sid: "QAS", client: "100", user: "DEVELOPER" }, { sid: "DEV", client: "100", user: "DEVELOPER" }, "expect_mismatch"),
    (err) => err.code === "expect_mismatch",
  )
})

test("差异可回放，源码哈希忽略换行符差异", () => {
  const before = "a\nb\nc"
  const after = "a\nx\nc"
  assert.equal(replayLineDiff(before, after), after)
  const diff = unifiedDiff(before, after, "ZDEMO (PROG/P)")
  assert.match(diff, /^-b$/m)
  assert.match(diff, /^\+x$/m)
  assert.equal(diffSha256(diff), diffSha256(unifiedDiff(before, after, "ZDEMO (PROG/P)")))
  assert.equal(sourceSha256("a\r\nb\n\n"), sourceSha256("a\nb"))
  const bigBefore = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
  const bigAfter = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n")
  assert.equal(replayLineDiff(bigBefore, bigAfter), bigAfter)
})

test("片段必须唯一；类用方法替换；程序不能整段覆盖", () => {
  assert.throws(
    () => applyEdit("WRITE 'A'.\nWRITE 'A'.", { mode: "replace", oldString: "WRITE 'A'.", newString: "WRITE 'B'." }, "PROG/P"),
    (err) => err.code === "snippet_not_unique",
  )
  const source = [
    "CLASS zcl_demo IMPLEMENTATION.",
    "  METHOD get_data.",
    "    WRITE 'OLD'.",
    "  ENDMETHOD.",
    "  METHOD keep.",
    "    WRITE 'KEEP'.",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n")
  const next = applyEdit(source, {
    mode: "method",
    method: "get_data",
    source: "  METHOD get_data.\n    WRITE 'NEW'.\n  ENDMETHOD.",
  }, "CLAS/OC")
  assert.match(next, /WRITE 'NEW'/)
  assert.match(next, /METHOD keep/)
  assert.doesNotMatch(next, /WRITE 'OLD'/)
  assert.throws(
    () => applyEdit(source, { mode: "include", source: "REPORT znew." }, "PROG/P"),
    (err) => err.code === "include_not_allowed",
  )
  assert.equal(applyEdit("* old", { mode: "include", source: "* new" }, "PROG/I"), "* new")
})

test("open 锁定系统、客户端、用户和单一对象，会话文件不含口令", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  assert.equal(opened.system.sid, "DEV")
  assert.equal(opened.system.client, "100")
  assert.equal(opened.system.user, "DEVELOPER")
  assert.equal(opened.object.name, "ZDEMO")
  assert.equal(opened.transport, "DEVK900123")
  assert.equal(opened.baselineSha256, sourceSha256(SOURCE))
  assert.equal(fx.state.writes.length, 0)
  const saved = readFileSync(join(dir, `${opened.sessionId}.json`), "utf8")
  assert.equal(saved.includes("secret-password"), false)
  assert.equal(saved.includes("password"), false)
})

test("expect 不一致、包不在允许列表、缺少或不可修改的请求都不能打开", async () => {
  const mismatch = fixture()
  const badExpect = await executeBotCommand({
    command: "open", objectName: "ZDEMO", transport: "DEVK900123", expect: "QAS.100/DEVELOPER",
  }, mismatch.deps)
  assert.equal(badExpect.code, "expect_mismatch")
  assert.equal(mismatch.state.calls.includes("resolve"), false)

  const foreign = fixture({ object: { packageName: "BASIS" } })
  const denied = await executeBotCommand({
    command: "open", objectName: "ZDEMO", transport: "DEVK900123",
  }, foreign.deps)
  assert.equal(denied.code, "package_denied")

  const widened = fixture()
  const widenedResult = await executeBotCommand({
    command: "open", objectName: "ZDEMO", transport: "DEVK900123", allowPackages: ["SAP*"],
  }, widened.deps)
  assert.equal(widenedResult.code, "package_allowlist")

  const noTr = fixture()
  const missingTr = await executeBotCommand({ command: "open", objectName: "ZDEMO" }, noTr.deps)
  assert.equal(missingTr.code, "transport_required")

  const released = fixture({ transport: { found: true, status: "R" } })
  const releasedResult = await executeBotCommand({
    command: "open", objectName: "ZDEMO", transport: "DEVK900123",
  }, released.deps)
  assert.equal(releasedResult.code, "transport_not_modifiable")

  const conflict = fixture({ objectTransports: [{ number: "DEVK900999", status: "D" }] })
  const conflictResult = await executeBotCommand({
    command: "open", objectName: "ZDEMO", transport: "DEVK900123",
  }, conflict.deps)
  assert.equal(conflictResult.code, "transport_conflict")
  for (const fx of [mismatch, foreign, widened, noTr, released, conflict]) assert.equal(fx.state.writes.length, 0)
})

test("propose 只保存 diff，不写 SAP", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  const proposed = await proposeDefault(fx, opened.sessionId)
  assert.equal(proposed.ok, true, proposed.message)
  assert.match(proposed.diff, /^-WRITE 'OLD'\.$/m)
  assert.match(proposed.diff, /^\+WRITE 'NEW'\.$/m)
  assert.equal(proposed.diffHash, diffSha256(proposed.diff))
  assert.equal(fx.state.writes.length, 0)
  assert.equal(fx.state.calls.includes("write"), false)
  assert.equal(fx.audits.at(-1).event, "proposed")
  assert.equal(fx.audits.at(-1).sessionId, opened.sessionId)
  assert.equal(fx.audits.at(-1).user, "DEVELOPER")
  assert.equal(fx.audits.at(-1).objects[0], "ZDEMO")
  assert.equal(fx.audits.at(-1).diffHash, proposed.diffHash)
  assert.equal(fx.audits.at(-1).sid, "DEV")
  assert.equal(fx.audits.at(-1).client, "100")
})

test("硬编码中文在提案阶段被拦截", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  const result = await proposeDefault(fx, opened.sessionId, {
    mode: "replace", oldString: "WRITE 'OLD'.", newString: "WRITE '你好'.",
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, "code_policy")
  assert.equal(fx.state.writes.length, 0)
  const status = await executeBotCommand({ command: "status", sessionId: opened.sessionId }, fx.deps)
  assert.equal(status.diffHash, null)
})

test("apply 拒绝哈希不一致、过期源码和错误对象，且不写 SAP", async () => {
  const hashFx = fixture()
  const hashOpen = await openDefault(hashFx)
  const hashProposal = await proposeDefault(hashFx, hashOpen.sessionId)
  const hashResult = await executeBotCommand({
    command: "apply", sessionId: hashOpen.sessionId, diffHash: "ab".repeat(32),
  }, hashFx.deps)
  assert.equal(hashResult.code, "hash_mismatch")
  assert.equal(hashFx.state.writes.length, 0)
  assert.equal(hashFx.audits.at(-1).event, "blocked")
  assert.equal(hashFx.audits.at(-1).diffHash, "ab".repeat(32))

  const staleFx = fixture()
  const staleOpen = await openDefault(staleFx)
  await proposeDefault(staleFx, staleOpen.sessionId)
  staleFx.state.source = "REPORT zdemo.\nWRITE 'OTHER'.\nWRITE 'KEEP'."
  const staleProposal = JSON.parse(readFileSync(join(dir, `${staleOpen.sessionId}.json`), "utf8"))
  const staleResult = await executeBotCommand({
    command: "apply", sessionId: staleOpen.sessionId, diffHash: staleProposal.proposal.diffHash,
  }, staleFx.deps)
  assert.equal(staleResult.code, "stale_source")
  assert.equal(staleFx.state.writes.length, 0)

  const wrongFx = fixture()
  const wrongOpen = await openDefault(wrongFx)
  const wrongProposal = await proposeDefault(wrongFx, wrongOpen.sessionId)
  const wrongResult = await executeBotCommand({
    command: "apply", sessionId: wrongOpen.sessionId, objectName: "ZOTHER", diffHash: wrongProposal.diffHash,
  }, wrongFx.deps)
  assert.equal(wrongResult.code, "wrong_object")
  assert.equal(wrongFx.state.writes.length, 0)
  assert.equal(hashProposal.ok, true)
})

test("只读配置和非开发客户端在写入前拦截", async () => {
  const readOnlyFx = fixture()
  const readOnlyOpen = await openDefault(readOnlyFx)
  const readOnlyProposal = await proposeDefault(readOnlyFx, readOnlyOpen.sessionId)
  sapConfig({ readOnly: true, category: "C" })
  await dropAllClients()
  const readOnlyResult = await executeBotCommand({
    command: "apply", sessionId: readOnlyOpen.sessionId, diffHash: readOnlyProposal.diffHash,
  }, readOnlyFx.deps)
  assert.equal(readOnlyResult.code, "readonly")
  assert.equal(readOnlyFx.state.writes.length, 0)

  const devFx = fixture()
  const devOpen = await openDefault(devFx)
  const devProposal = await proposeDefault(devFx, devOpen.sessionId)
  sapConfig({ readOnly: false, category: "T" })
  await dropAllClients()
  const devResult = await executeBotCommand({
    command: "apply", sessionId: devOpen.sessionId, diffHash: devProposal.diffHash,
  }, devFx.deps)
  assert.equal(devResult.code, "dev_client")
  assert.match(devResult.message, /T000\.CCCATEGORY=T/)
  assert.equal(devFx.state.writes.length, 0)
  assert.equal(devFx.state.calls.includes("write"), false)
})

test("apply 在哈希、基线和开发客户端都通过后写入并核对", async () => {
  const fx = fixture({ inactive: [{ type: "PROG/P", name: "ZDEMO" }] })
  const opened = await openDefault(fx)
  const proposed = await proposeDefault(fx, opened.sessionId)
  const applied = await executeBotCommand({
    command: "apply", sessionId: opened.sessionId, diffHash: proposed.diffHash,
  }, fx.deps)
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(fx.state.writes.length, 1)
  assert.equal(fx.state.writes[0].transport, "DEVK900123")
  assert.match(fx.state.writes[0].source, /WRITE 'NEW'/)
  assert.equal(applied.readback, "match")
  assert.equal(applied.syntax.errors.length, 0)
  assert.equal(applied.inactive[0].name, "ZDEMO")
  assert.equal(fx.audits.at(-1).event, "applied")
  assert.equal(fx.audits.at(-1).sessionId, opened.sessionId)
  assert.equal(fx.audits.at(-1).user, "DEVELOPER")
  assert.equal(fx.audits.at(-1).diffHash, proposed.diffHash)
  const status = await executeBotCommand({ command: "status", sessionId: opened.sessionId }, fx.deps)
  assert.equal(status.status, "applied")
})

test("读回不一致、语法错误或解锁失败都不能报成功", async () => {
  const mismatch = fixture({
    onWrite(source) {
      mismatch.state.source = `${source}\nWRITE 'EXTRA'.`
      return { written: true }
    },
  })
  const mismatchOpen = await openDefault(mismatch)
  const mismatchProposal = await proposeDefault(mismatch, mismatchOpen.sessionId)
  const mismatchResult = await executeBotCommand({
    command: "apply", sessionId: mismatchOpen.sessionId, diffHash: mismatchProposal.diffHash,
  }, mismatch.deps)
  assert.equal(mismatchResult.ok, false)
  assert.equal(mismatchResult.readback, "mismatch")
  assert.equal(mismatch.state.writes.length, 1)
  assert.equal(mismatch.audits.at(-1).event, "failed")
  const mismatchStatus = await executeBotCommand({ command: "status", sessionId: mismatchOpen.sessionId }, mismatch.deps)
  assert.equal(mismatchStatus.status, "apply_unverified")

  const syntaxFx = fixture({ syntax: [{ severity: "E", line: 2, text: "Statement not expected" }] })
  const syntaxOpen = await openDefault(syntaxFx)
  const syntaxProposal = await proposeDefault(syntaxFx, syntaxOpen.sessionId)
  const syntaxResult = await executeBotCommand({
    command: "apply", sessionId: syntaxOpen.sessionId, diffHash: syntaxProposal.diffHash,
  }, syntaxFx.deps)
  assert.equal(syntaxResult.ok, false)
  assert.equal(syntaxResult.code, "syntax_error")
  assert.equal(syntaxResult.syntax.errors[0].text, "Statement not expected")

  const unlockFx = fixture({
    onWrite(source) {
      unlockFx.state.source = source
      return { written: true, unlockError: "unlock failed" }
    },
  })
  const unlockOpen = await openDefault(unlockFx)
  const unlockProposal = await proposeDefault(unlockFx, unlockOpen.sessionId)
  const unlockResult = await executeBotCommand({
    command: "apply", sessionId: unlockOpen.sessionId, diffHash: unlockProposal.diffHash,
  }, unlockFx.deps)
  assert.equal(unlockResult.ok, false)
  assert.equal(unlockResult.code, "unlock_failed")
})

test("激活必须发生在已核对的写入之后，未激活对象不能报成功", async () => {
  const early = fixture()
  const earlyOpen = await openDefault(early)
  const earlyProposal = await proposeDefault(early, earlyOpen.sessionId)
  const earlyResult = await executeBotCommand({
    command: "activate", sessionId: earlyOpen.sessionId, diffHash: earlyProposal.diffHash,
  }, early.deps)
  assert.equal(earlyResult.code, "not_applied")
  assert.equal(early.state.calls.includes("activate"), false)

  const fx = fixture()
  const opened = await openDefault(fx)
  const proposed = await proposeDefault(fx, opened.sessionId)
  const applied = await executeBotCommand({
    command: "apply", sessionId: opened.sessionId, diffHash: proposed.diffHash,
  }, fx.deps)
  assert.equal(applied.ok, true, applied.message)
  const activated = await executeBotCommand({
    command: "activate", sessionId: opened.sessionId, diffHash: proposed.diffHash,
  }, fx.deps)
  assert.equal(activated.ok, true, JSON.stringify(activated))
  assert.equal(activated.stillInactive, false)
  assert.equal(fx.audits.at(-1).event, "activated")
  assert.equal(fx.audits.at(-1).diffHash, proposed.diffHash)
  assert.equal(fx.audits.at(-1).user, "DEVELOPER")

  const stuck = fixture({ inactive: [{ type: "PROG/P", name: "ZDEMO" }] })
  const stuckOpen = await openDefault(stuck)
  const stuckProposal = await proposeDefault(stuck, stuckOpen.sessionId)
  await executeBotCommand({ command: "apply", sessionId: stuckOpen.sessionId, diffHash: stuckProposal.diffHash }, stuck.deps)
  const stuckResult = await executeBotCommand({
    command: "activate", sessionId: stuckOpen.sessionId, diffHash: stuckProposal.diffHash,
  }, stuck.deps)
  assert.equal(stuckResult.ok, false)
  assert.equal(stuckResult.stillInactive, true)
  assert.notEqual(stuckResult.code, undefined)
})

test("会话 diff 被改过、身份变化、请求变为已释放时拒绝写入", async () => {
  const tampered = fixture()
  const tamperedOpen = await openDefault(tampered)
  const tamperedProposal = await proposeDefault(tampered, tamperedOpen.sessionId)
  const file = join(dir, `${tamperedOpen.sessionId}.json`)
  const saved = JSON.parse(readFileSync(file, "utf8"))
  saved.proposal.diff += "+WRITE 'TAMPER'.\n"
  writeFileSync(file, JSON.stringify(saved))
  const tamperedResult = await executeBotCommand({
    command: "apply", sessionId: tamperedOpen.sessionId, diffHash: tamperedProposal.diffHash,
  }, tampered.deps)
  assert.equal(tamperedResult.code, "session_corrupt")
  assert.equal(tampered.state.writes.length, 0)

  const moved = fixture()
  const movedOpen = await openDefault(moved)
  const movedProposal = await proposeDefault(moved, movedOpen.sessionId)
  moved.state.user = "OTHER"
  const movedResult = await executeBotCommand({
    command: "apply", sessionId: movedOpen.sessionId, diffHash: movedProposal.diffHash,
  }, moved.deps)
  assert.equal(movedResult.code, "identity_mismatch")
  assert.equal(moved.state.writes.length, 0)

  const frozen = fixture()
  const frozenOpen = await openDefault(frozen)
  const frozenProposal = await proposeDefault(frozen, frozenOpen.sessionId)
  frozen.state.transport = { found: true, status: "R" }
  const frozenResult = await executeBotCommand({
    command: "apply", sessionId: frozenOpen.sessionId, diffHash: frozenProposal.diffHash,
  }, frozen.deps)
  assert.equal(frozenResult.code, "transport_not_modifiable")
  assert.equal(frozen.state.writes.length, 0)
})

test("会话内只读命令可用，写 SQL 被拒绝", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  const read = await executeBotCommand({ command: "read", sessionId: opened.sessionId }, fx.deps)
  assert.equal(read.ok, true)
  assert.equal(read.stale, false)
  assert.match(read.source, /WRITE 'OLD'/)
  const used = await executeBotCommand({ command: "where-used", sessionId: opened.sessionId }, fx.deps)
  assert.equal(used.references[0].name, "ZCALLER")
  const checked = await executeBotCommand({ command: "syntax", sessionId: opened.sessionId }, fx.deps)
  assert.equal(checked.ok, true)
  const atc = await executeBotCommand({ command: "atc", sessionId: opened.sessionId }, fx.deps)
  assert.equal(atc.available, false)
  const table = await executeBotCommand({
    command: "table", sessionId: opened.sessionId, table: "T000", filter: "MANDT = '100'",
  }, fx.deps)
  assert.equal(table.ok, true)
  assert.equal(table.rows[0].MANDT, "100")
  const rejected = await executeBotCommand({
    command: "table", sessionId: opened.sessionId, sql: "INSERT INTO T000 VALUES ('100')",
  }, fx.deps)
  assert.equal(rejected.code, "sql_rejected")
  assert.equal(fx.state.calls.some((call) => String(call).startsWith("sql:")), false)
  const wrong = await executeBotCommand({
    command: "read", sessionId: opened.sessionId, objectName: "ZOTHER",
  }, fx.deps)
  assert.equal(wrong.code, "wrong_object")
})

test("关闭后的会话不能再提议", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  const closed = await executeBotCommand({ command: "close", sessionId: opened.sessionId }, fx.deps)
  assert.equal(closed.ok, true)
  const proposed = await proposeDefault(fx, opened.sessionId)
  assert.equal(proposed.code, "session_closed")
  assert.equal(fx.state.writes.length, 0)
})

test("CLI 解析提案、拒绝创建传输，并用哈希完成 apply", async () => {
  const fx = fixture()
  const opened = await runSessionCli([
    "open", "ZDEMO", "--type", "PROG/P", "--transport", "DEVK900123", "--expect", "DEV.100/DEVELOPER",
  ], { dir, runtime: runtimeFor(fx.state), guard: assertBotWriteAllowed, audit: (entry) => fx.audits.push(entry), packageCeiling: () => ["Z*", "Y*"] })
  assert.equal(opened.code, 0, opened.result.message)
  const proposed = await runSessionCli([
    "propose", opened.result.sessionId, "--old", "WRITE 'OLD'.", "--new", "WRITE 'NEW'.",
  ], { dir, runtime: runtimeFor(fx.state), guard: assertBotWriteAllowed, audit: (entry) => fx.audits.push(entry), packageCeiling: () => ["Z*", "Y*"] })
  assert.equal(proposed.code, 0, proposed.result.message)
  assert.equal(fx.state.writes.length, 0)
  const applied = await runSessionCli([
    "apply", opened.result.sessionId, "--diff-hash", proposed.result.diffHash,
  ], { dir, runtime: runtimeFor(fx.state), guard: assertBotWriteAllowed, audit: (entry) => fx.audits.push(entry), packageCeiling: () => ["Z*", "Y*"] })
  assert.equal(applied.code, 0, JSON.stringify(applied.result))
  assert.equal(fx.state.writes.length, 1)

  const missing = await runSessionCli(["apply", opened.result.sessionId], { dir, runtime: runtimeFor(fx.state) })
  assert.equal(missing.code, 1)
  assert.equal(missing.result.code, "usage")
  const release = await runSessionCli(["release", "DEVK900123"], { dir })
  assert.equal(release.result.code, "transport_command")
  const create = await runSessionCli(["create-transport"], { dir })
  assert.equal(create.result.code, "transport_command")
})

test("session 子命令从 CLI 入口输出 JSON，不进入对话", () => {
  const help = execFileSync(process.execPath, ["cli.mjs", "session", "help"], { cwd: ROOT, encoding: "utf8" })
  const helpJson = JSON.parse(help)
  assert.equal(helpJson.ok, true)
  assert.ok(helpJson.commands.some((line) => line.includes("propose")))
  assert.ok(helpJson.workflow.includes("apply --diff-hash"))
  let failed = false
  try {
    execFileSync(process.execPath, ["cli.mjs", "session", "create-transport"], { cwd: ROOT, encoding: "utf8" })
  } catch (err) {
    failed = true
    assert.notEqual(err.status, 0)
    assert.equal(JSON.parse(err.stdout).code, "transport_command")
  }
  assert.equal(failed, true)
})

test("loadConfig 保留 bot session 的包允许列表", () => {
  const file = join(dir, "connections.json")
  writeFileSync(file, JSON.stringify({
    connections: [{ id: "dev", url: "https://fixture.invalid", client: "100", username: "DEVELOPER", password: "secret-password" }],
    security: { readOnly: true, allowedPackages: ["ZFOO", "Y*"] },
  }))
  const previous = process.env.ABAP_MCP_CONFIG
  process.env.ABAP_MCP_CONFIG = file
  try {
    const loaded = loadConfig()
    assert.deepEqual(loaded.security.allowedPackages, ["ZFOO", "Y*"])
    assert.equal(loaded.security.readOnly, true)
  } finally {
    if (previous === undefined) delete process.env.ABAP_MCP_CONFIG
    else process.env.ABAP_MCP_CONFIG = previous
  }
})

test("bot session 源码没有创建或释放传输请求的调用", () => {
  for (const file of ["service.ts", "runtime.ts", "cli.ts", "connection.ts"]) {
    const text = readFileSync(join(ROOT, "src", "sap-tools", "bot-session", file), "utf8")
    assert.equal(text.includes("createTransport"), false, file)
    assert.equal(text.includes("transportRelease"), false, file)
    assert.equal(text.includes("writeFile"), false, file)
  }
  const runtime = readFileSync(join(ROOT, "src", "sap-tools", "bot-session", "runtime.ts"), "utf8")
  assert.equal(runtime.includes("resolveConnectionId"), false)
})

function consultantConfig() {
  return {
    connections: [
      { id: "dev", name: "开发", active: true, url: "https://dev.fixture.invalid", client: "100", username: "DEVELOPER", password: "secret-dev" },
      { id: "qa", name: "测试", active: false, url: "https://qa.fixture.invalid", client: "200", username: "SD_USER", password: "secret-qa" },
    ],
    security: { readOnly: false, allowedPackages: ["Z*", "Y*"] },
  }
}

function withProfiles(fx) {
  fx.state.profiles = {
    dev: { sid: "DEV", client: "100", user: "DEVELOPER" },
    qa: { sid: "QAS", client: "200", user: "SD_USER" },
  }
  return fx
}

test("不指定连接时锁定 active，没有 active 时用第一个", async () => {
  const fx = fixture()
  const opened = await openDefault(fx)
  assert.equal(opened.connectionId, "dev")
  assert.equal(opened.connectionSelection, "default")
  assert.match(opened.message, /默认连接 dev/)
  assert.equal(getConfig().connections[0].active, true)

  __setConfigForTest({
    connections: [
      { id: "first", name: "甲", url: "https://fixture.invalid", client: "100", username: "A", password: "p" },
      { id: "second", name: "乙", url: "https://fixture.invalid", client: "100", username: "B", password: "p" },
    ],
    security: { readOnly: true },
  })
  assert.deepEqual(selectConnectionForOpen(undefined), { id: "first", selection: "default" })
  assert.deepEqual(selectConnectionForOpen("乙"), { id: "second", selection: "explicit" })
  __setConfigForTest({
    connections: [
      { id: "a", name: "同名", url: "https://fixture.invalid", client: "100", username: "A", password: "p" },
      { id: "b", name: "同名", url: "https://fixture.invalid", client: "100", username: "B", password: "p" },
    ],
    security: { readOnly: true },
  })
  assert.throws(
    () => selectConnectionForOpen("同名"),
    (err) => err instanceof BotGateError && err.code === "connection_ambiguous",
  )
  assert.deepEqual(selectConnectionForOpen("b"), { id: "b", selection: "explicit" })
})

test("两个会话各用自己的连接，不改写 active，缺连接时拒绝", async () => {
  const original = consultantConfig()
  __setConfigForTest(structuredClone(original))
  const fx = withProfiles(fixture())
  const devOpen = await executeBotCommand({
    command: "open", objectName: "ZDEMO", objectType: "PROG/P", transport: "DEVK900123",
    expect: "DEV.100/DEVELOPER", connectionId: "开发",
  }, fx.deps)
  assert.equal(devOpen.ok, true, devOpen.message)
  assert.equal(devOpen.connectionId, "dev")
  assert.equal(devOpen.connectionSelection, "explicit")
  const qaOpen = await executeBotCommand({
    command: "open", objectName: "ZDEMO", objectType: "PROG/P", transport: "DEVK900123",
    expect: "QAS.200/SD_USER", connectionId: "qa",
  }, fx.deps)
  assert.equal(qaOpen.ok, true, qaOpen.message)
  assert.equal(qaOpen.connectionId, "qa")
  const wrongSystem = await executeBotCommand({
    command: "open", objectName: "ZDEMO", objectType: "PROG/P", transport: "DEVK900123",
    expect: "DEV.100/DEVELOPER", connectionId: "测试",
  }, fx.deps)
  assert.equal(wrongSystem.code, "expect_mismatch")

  const beforeQaRead = fx.state.used.length
  const qaRead = await executeBotCommand({ command: "read", sessionId: qaOpen.sessionId }, fx.deps)
  assert.equal(qaRead.ok, true, qaRead.message)
  assert.deepEqual(fx.state.used.slice(beforeQaRead), ["qa", "qa"])
  const beforeDevRead = fx.state.used.length
  const devRead = await executeBotCommand({ command: "read", sessionId: devOpen.sessionId }, fx.deps)
  assert.equal(devRead.ok, true, devRead.message)
  assert.deepEqual(fx.state.used.slice(beforeDevRead), ["dev", "dev"])

  assert.equal(getConfig().connections.find((item) => item.id === "dev").active, true)
  assert.equal(getConfig().connections.find((item) => item.id === "qa").active, false)
  assert.deepEqual(
    getConfig().connections.map((item) => ({ id: item.id, active: item.active ?? false, name: item.name })),
    original.connections.map((item) => ({ id: item.id, active: item.active ?? false, name: item.name })),
  )
  await assert.rejects(resolveConnectionId("qa"), /连接范围拦截/)

  const usedBeforeMissing = fx.state.used.length
  __setConfigForTest({
    connections: [original.connections[0]],
    security: original.security,
  })
  const missing = await executeBotCommand({ command: "read", sessionId: qaOpen.sessionId }, fx.deps)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, "connection_missing")
  assert.match(missing.message, /qa/)
  assert.equal(fx.state.used.length, usedBeforeMissing)
  const status = await executeBotCommand({ command: "status", sessionId: qaOpen.sessionId }, fx.deps)
  assert.equal(status.code, "connection_missing")
  const devStill = await executeBotCommand({ command: "read", sessionId: devOpen.sessionId }, fx.deps)
  assert.equal(devStill.ok, true, devStill.message)
})

test("打开两个会话不改写 connections.json 文件", async () => {
  const file = join(dir, "connections.json")
  const body = JSON.stringify({
    connections: [
      { id: "Dev", name: "开发", active: true, url: "https://dev.fixture.invalid", client: "100", username: "DEVELOPER", password: "secret-dev" },
      { id: "QA", name: "测试", url: "https://qa.fixture.invalid", client: "200", username: "SD_USER", password: "secret-qa" },
    ],
    security: { readOnly: false, allowedPackages: ["Z*", "Y*"] },
  }, null, 2)
  writeFileSync(file, body)
  const previous = process.env.ABAP_MCP_CONFIG
  process.env.ABAP_MCP_CONFIG = file
  __setConfigForTest(null)
  try {
    const fx = withProfiles(fixture())
    const devOpen = await executeBotCommand({
      command: "open", objectName: "ZDEMO", objectType: "PROG/P", transport: "DEVK900123",
      expect: "DEV.100/DEVELOPER", connectionId: "开发",
    }, fx.deps)
    const qaOpen = await executeBotCommand({
      command: "open", objectName: "ZDEMO", objectType: "PROG/P", transport: "DEVK900123",
      expect: "QAS.200/SD_USER", connectionId: "QA",
    }, fx.deps)
    assert.equal(devOpen.connectionId, "dev")
    assert.equal(qaOpen.connectionId, "qa")
    assert.equal(readFileSync(file, "utf8"), body)
    const loaded = loadConfig()
    assert.equal(loaded.connections.find((item) => item.id === "dev").active, true)
    assert.equal(loaded.connections.find((item) => item.id === "qa").active, undefined)
  } finally {
    if (previous === undefined) delete process.env.ABAP_MCP_CONFIG
    else process.env.ABAP_MCP_CONFIG = previous
    sapConfig()
  }
})

test("CLI 的 --connection 优先于 SAPBUDDY_CONNECTION", async () => {
  __setConfigForTest(consultantConfig())
  const fx = withProfiles(fixture())
  const options = {
    dir,
    runtime: runtimeFor(fx.state),
    packageCeiling: () => ["Z*", "Y*"],
  }
  const byName = await runSessionCli([
    "open", "ZDEMO", "--connection", "测试", "--type", "PROG/P", "--transport", "DEVK900123", "--expect", "QAS.200/SD_USER",
  ], { ...options, env: { SAPBUDDY_CONNECTION: "dev" } })
  assert.equal(byName.code, 0, byName.result.message)
  assert.equal(byName.result.connectionId, "qa")
  assert.equal(byName.result.connectionSelection, "explicit")

  const byEnv = await runSessionCli([
    "open", "ZDEMO", "--type", "PROG/P", "--transport", "DEVK900123", "--expect", "DEV.100/DEVELOPER",
  ], { ...options, env: { SAPBUDDY_CONNECTION: "开发" } })
  assert.equal(byEnv.code, 0, byEnv.result.message)
  assert.equal(byEnv.result.connectionId, "dev")
  assert.equal(byEnv.result.connectionSelection, "explicit")

  const unknown = await runSessionCli([
    "open", "ZDEMO", "--connection", "missing", "--type", "PROG/P", "--transport", "DEVK900123",
  ], { ...options, env: {} })
  assert.equal(unknown.code, 1)
  assert.equal(unknown.result.code, "connection_missing")
  assert.equal(fx.state.used.includes("missing"), false)
})

test("生产运行时只连接会话指定的系统，缺连接时不登录", async () => {
  __setConfigForTest(consultantConfig())
  const logins = []
  __setClientFactoryForTest((conf) => {
    logins.push(conf.id)
    return {
      login: async () => {},
      username: conf.username,
      client: conf.client,
      dropSession: async () => {},
      httpClient: { ascookies: () => (conf.id === "qa" ? "SAP_SESSIONID_QAS_00=abc" : "SAP_SESSIONID_DEV_00=abc") },
    }
  })
  await assert.rejects(
    () => productionRuntime.identity("missing"),
    (err) => err instanceof BotGateError && err.code === "connection_missing",
  )
  assert.deepEqual(logins, [])
  const live = await productionRuntime.identity("qa")
  assert.equal(live.connectionId, "qa")
  assert.equal(live.sid, "QAS")
  assert.equal(live.client, "200")
  assert.equal(live.user, "SD_USER")
  assert.deepEqual(logins, ["qa"])
  assert.equal(getConfig().connections.find((item) => item.id === "dev").active, true)
  await dropAllClients()
})
