import { addEqualityTesters } from "@effect/vitest"

// Structural equality for Effect data types (Option, Result, Data, …) in `expect(...).toEqual`.
addEqualityTesters()
