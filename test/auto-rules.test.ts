import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, hasRule, parseRule } from "../src/auto-rules.ts";

const E = 10n ** 18n;
const base = { cost: E, value: E, sl: null, trail: null, tiers: [], done: 0, peak: 0n };

test("固定止盈止损与原有判断一致，止损优先", () => {
  assert.equal(evaluate({ ...base, value: 2n * E, tiers: [{ at: 100, pct: 100 }], sl: 30 }).action?.kind, "tp");
  assert.equal(evaluate({ ...base, value: 19n * E / 10n, tiers: [{ at: 100, pct: 100 }], sl: 30 }).action, null);
  assert.equal(evaluate({ ...base, value: 7n * E / 10n, tiers: [{ at: 100, pct: 100 }], sl: 30 }).action?.kind, "sl");
  assert.equal(evaluate({ ...base, value: 8n * E / 10n, sl: 30 }).action, null);
  assert.equal(evaluate({ ...base, value: 0n, sl: 30, tiers: [{ at: 100, pct: 100 }] }).action?.kind, "sl");
  assert.equal(evaluate({ ...base, cost: 0n, value: E, sl: 30 }).action, null);
});

test("分档止盈逐档触发，每轮只触发一档，档数推进后才会执行下一档", () => {
  const tiers = [{ at: 50, pct: 50 }, { at: 100, pct: 100 }];
  const first = evaluate({ ...base, value: 2n * E, tiers });
  assert.deepEqual(first.action, { kind: "tp", pct: 50 });
  assert.equal(evaluate({ ...base, value: 2n * E, tiers, done: 1 }).action?.pct, 100);
  assert.equal(evaluate({ ...base, value: 2n * E, tiers, done: 2 }).action, null);
  assert.equal(evaluate({ ...base, value: 16n * E / 10n, tiers }).action?.pct, 50);
  assert.equal(evaluate({ ...base, value: 16n * E / 10n, tiers, done: 1 }).action, null);
});

test("移动止损从最高价回撤触发，未超过成本时不启用", () => {
  const trail = { ...base, trail: 20 };
  const up = evaluate({ ...trail, value: 15n * E / 10n });
  assert.equal(up.action, null); assert.equal(up.peak, 15n * E / 10n);
  assert.equal(evaluate({ ...trail, value: 12n * E / 10n, peak: 15n * E / 10n }).action?.kind, "trail");
  assert.equal(evaluate({ ...trail, value: 13n * E / 10n, peak: 15n * E / 10n }).action, null);
  assert.equal(evaluate({ ...trail, value: 9n * E / 10n, peak: E }).action, null);
});

test("止损先于移动止损和分档止盈", () => {
  const r = evaluate({ ...base, value: 7n * E / 10n, sl: 30, trail: 10, peak: 2n * E, tiers: [{ at: 50, pct: 50 }] });
  assert.equal(r.action?.kind, "sl");
});

test("hasRule 只在有规则时返回真", () => {
  assert.equal(hasRule({ sl: null, trail: null, tiers: [] }), false);
  assert.equal(hasRule({ sl: null, trail: 10, tiers: [] }), true);
  assert.equal(hasRule({ sl: null, trail: null, tiers: [{ at: 1, pct: 10 }] }), true);
});

test("解析旧格式、分档、固定止损和移动止损", () => {
  assert.deepEqual(parseRule("100 30"), { tp: 100, sl: 30, tiers: [{ at: 100, pct: 100 }], trail: null });
  assert.deepEqual(parseRule("50/50 100/100 sl30 trail20"), { tp: null, sl: 30, tiers: [{ at: 50, pct: 50 }, { at: 100, pct: 100 }], trail: 20 });
  assert.deepEqual(parseRule("trail15"), { tp: null, sl: null, tiers: [], trail: 15 });
  assert.equal(parseRule("off"), "off");
});

test("拒绝无效或有歧义的规则", () => {
  for (const bad of ["", "0 0", "100", "100 100", "sl0", "trail100", "50/0", "50/101", "100/100 50/50", "50/50 40/50", "100/50 50/100", "sl30 sl20", "foo", "1 2 3"]) {
    assert.equal(parseRule(bad), null, bad);
  }
});
