import test from "node:test";
import assert from "node:assert/strict";
import { h, Fragment, createCommentVNode, createTextVNode } from "vue";
import {
  selectOptions,
  selectValue,
  checkboxState,
  checkboxValue,
  EMPTY_SELECT_VALUE,
} from "../lib/adminControls.ts";

test("implicit option text stays its value (GET/POST)", () => {
  assert.deepEqual(
    selectOptions([h("option", "GET"), h("option", "POST")]).map(
      (o) => o.value,
    ),
    ["GET", "POST"],
  );
});
test("empty all-items filters use a nonempty Select sentinel", () => {
  assert.deepEqual(selectOptions([h("option", { value: "" }, "全部")]), [
    { value: EMPTY_SELECT_VALUE, text: "全部", disabled: false },
  ]);
  assert.equal(selectValue(EMPTY_SELECT_VALUE, "quark"), "");
});
test("numeric page size remains numeric, zero remains valid", () => {
  assert.equal(selectValue("50", 20), 50);
  assert.equal(selectOptions([h("option", { value: 0 }, "零")])[0].value, "0");
});
test("dynamic fragment options ignore comments and preserve nested text", () => {
  const options = selectOptions([
    h(Fragment, [
      createCommentVNode("v-if"),
      h("option", { value: "one" }, [createTextVNode("一"), h("span", "号")]),
    ]),
  ]);
  assert.deepEqual(options, [{ value: "one", text: "一号", disabled: false }]);
});
test("disabled options preserve native Boolean semantics", () => {
  assert.deepEqual(
    selectOptions([
      h("option", { disabled: "" }, "禁用"),
      h("option", { disabled: false }, "可用"),
    ]).map((o) => o.disabled),
    [true, false],
  );
});
test("checked-only bindings and explicit false are distinguishable", () => {
  assert.equal(checkboxState(undefined, true), true);
  assert.equal(checkboxState(false, true), false);
  assert.equal(checkboxState(undefined, undefined), false);
});
test("array membership and indeterminate header state are controlled", () => {
  assert.equal(checkboxState(["one"], undefined, "one"), true);
  assert.equal(checkboxState(["one"], undefined, "two"), false);
  assert.equal(
    checkboxState(undefined, true, undefined, true),
    "indeterminate",
  );
});
test("checkbox updates never mutate or duplicate selected ids", () => {
  const selected = ["one"];
  assert.deepEqual(checkboxValue(selected, "one", true), ["one"]);
  assert.deepEqual(checkboxValue(selected, "two", true), ["one", "two"]);
  assert.deepEqual(checkboxValue(selected, "one", false), []);
  assert.deepEqual(selected, ["one"]);
  assert.equal(checkboxValue(false, undefined, true), true);
});
