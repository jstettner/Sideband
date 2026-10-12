// Generates packages/protocol/openapi.json from the HttpApi definition.
// `--check` fails instead of writing when the committed file is out of date (for CI).
import { OpenApi } from "effect/http-api"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { SidebandApi } from "../Api/Api.ts"

const path = new URL("../../openapi.json", import.meta.url)

const generated = JSON.stringify(OpenApi.fromApi(SidebandApi), null, 2) + "\n"

if (process.argv.includes("--check")) {
  const committed = existsSync(path) ? readFileSync(path, "utf8") : ""

  if (committed !== generated) {
    console.error("packages/protocol/openapi.json is out of date. Run `bun run openapi`.")
    process.exit(1)
  }
} else {
  writeFileSync(path, generated)
}
