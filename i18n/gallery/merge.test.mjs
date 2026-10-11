import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLocale } from "./merge.mjs";

const upstream = {
  a: "up a",
  admin: { b: "up b", c: "up c" },
  d: "up d",
  e: "up e",
};

test("upstream wins unless listed; exclusive drops untranslated upstream", () => {
  const overlay = {
    a: "fork a",
    admin: { b: "fork b", x: "fork x" },
    z: "fork z",
  };
  const overrides = new Map([
    ["admin.b", "override"],
    ["d", "exclusive"],
    ["e", "override"],
  ]);
  assert.deepEqual(mergeLocale(upstream, overlay, overrides), {
    a: "up a",
    admin: { b: "fork b", c: "up c", x: "fork x" },
    e: "up e",
    z: "fork z",
  });
});

test("an exclusive key keeps the overlay translation where there is one", () => {
  assert.equal(
    mergeLocale(upstream, { d: "fork d" }, new Map([["d", "exclusive"]])).d,
    "fork d",
  );
});
