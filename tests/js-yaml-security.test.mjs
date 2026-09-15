import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";

test("YAML merge budget counts empty mappings", () => {
  const source = "empty: &empty {}\nvalue:\n  <<: [*empty, *empty]\n";

  assert.deepEqual(yaml.load(source, { maxTotalMergeKeys: 2 }), { empty: {}, value: {} });
  assert.throws(
    () => yaml.load(source, { maxTotalMergeKeys: 1 }),
    /merge keys exceeded maxTotalMergeKeys/
  );
});
