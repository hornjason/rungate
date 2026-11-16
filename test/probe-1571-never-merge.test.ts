// TEMPORARY — #1571 probe. Fails on purpose so the probe PR can never merge.
import { expect, test } from "bun:test";
test("probe PR for #1571 must never merge", () => {
  expect("probe").toBe("never merged");
});
