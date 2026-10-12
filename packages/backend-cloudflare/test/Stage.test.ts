import { describe, expect, it } from "@effect/vitest"
import { props } from "../src/Sideband/SidebandWorker.ts"
import { PROD } from "../src/Stage.ts"

describe("stages", () => {
  it("prod deploys over the script wrangler created, so its workers.dev URL doesn't change", () => {
    expect(props(PROD)).toMatchObject({ name: "sideband" })
  })

  it("local stages leave the script name to Alchemy", () => {
    expect(props("dev_stet")).not.toHaveProperty("name")
  })
})
