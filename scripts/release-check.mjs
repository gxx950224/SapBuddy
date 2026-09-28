import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const env = { ...process.env, SAPBUDDY_REQUIRE_BROWSER_TESTS: "1",
  SAPBUDDY_PLAYWRIGHT: process.env.SAPBUDDY_PLAYWRIGHT || require.resolve("playwright") }
const result = spawnSync(process.execPath, ["--test"], { stdio: "inherit", env })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
