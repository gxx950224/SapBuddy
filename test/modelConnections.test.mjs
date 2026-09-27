import test from "node:test"
import assert from "node:assert/strict"
import { removeModelConnection } from "../src/web/model-connections.mjs"

test("delete model connection removes credentials and updates active selection without changing input", () => {
  const models = { providers: { local: { models: ["a"] }, remote: { models: [{ id: "b" }] } } }
  const auth = { local: { key: "fixture-local" }, remote: { key: "fixture-remote" } }
  const settings = { defaultProvider: "local", defaultModel: "a", contextTokens: 200000 }
  const next = removeModelConnection("local", models, auth, settings)
  assert.deepEqual(Object.keys(next.models.providers), ["remote"])
  assert.deepEqual(Object.keys(next.auth), ["remote"])
  assert.deepEqual(next.settings, { ...settings, defaultProvider: "remote", defaultModel: "b" })
  assert.ok(models.providers.local)
  assert.ok(auth.local)
  assert.equal(settings.defaultProvider, "local")
  assert.deepEqual(removeModelConnection("remote", models, auth, settings).settings, settings)
  assert.throws(() => removeModelConnection("missing", models, auth, settings), /不存在/)
  assert.throws(() => removeModelConnection("remote", next.models, next.auth, next.settings), /至少保留/)
})
