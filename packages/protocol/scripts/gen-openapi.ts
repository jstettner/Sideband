// Generates protocol/openapi.json from the HttpApi definition.
// `--check` fails instead of writing when the committed file is out of date (for CI).
import { OpenApi } from "effect/http-api"
import { SidebandApi } from "../src/Api.ts"

const path = new URL("../openapi.json", import.meta.url)
const generated = JSON.stringify(OpenApi.fromApi(SidebandApi), null, 2) + "\n"

if (process.argv.includes("--check")) {
  const file = Bun.file(path)
  const committed = (await file.exists()) ? await file.text() : ""
  if (committed !== generated) {
    console.error("protocol/openapi.json is out of date. Run `bun run gen` in protocol/.")
    process.exit(1)
  }
} else {
  await Bun.write(path, generated)
}
