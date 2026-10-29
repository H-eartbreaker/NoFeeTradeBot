import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERVAL_MS, startMonitor } from "../src/monitor.ts";
import type { State } from "../src/state.ts";

test("止盈止损每 3 秒调度，停止后不再调度", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let checks = 0;
  const state = { positions: () => { checks++; return []; } } as unknown as State;
  const stop = startMonitor({ state, deps: new Map(), slippageBps: () => 1000, notify: async () => undefined });
  assert.equal(INTERVAL_MS, 3000);
  t.mock.timers.tick(2999); assert.equal(checks, 0);
  t.mock.timers.tick(1); assert.equal(checks, 1);
  await Promise.resolve();
  t.mock.timers.tick(3000); assert.equal(checks, 2);
  stop(); t.mock.timers.tick(3000); assert.equal(checks, 2);
});
