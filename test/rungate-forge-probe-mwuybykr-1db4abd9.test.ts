// Forge probe fixture (#2749). It fails on purpose, so this pull request can never merge.
import { test } from "bun:test";
test("forge probe fixture never merges", () => {
  throw new Error("forge probe fixture: never merge");
});
