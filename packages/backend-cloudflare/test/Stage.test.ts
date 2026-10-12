import { describe, expect, it } from "@effect/vitest"
import { props } from "../src/Sideband/SidebandWorker.ts"
import { isLocalStage, PROD } from "../src/Stage.ts"

describe("stages", () => {
  it("dev_* and test_* stages are local; prod and anything else are not", () => {
    expect(["dev_stet", "test_stet"].map(isLocalStage)).toEqual([true, true])
    expect([PROD, "staging", "devstet", "live_stet"].map(isLocalStage)).toEqual([false, false, false, false])
  })

  it("prod deploys over the script wrangler created, so its workers.dev URL doesn't change", () => {
    expect(props(PROD)).toMatchObject({ name: "sideband" })
  })

  it("local stages leave the script name to Alchemy", () => {
    expect(props("dev_stet")).not.toHaveProperty("name")
  })
})
