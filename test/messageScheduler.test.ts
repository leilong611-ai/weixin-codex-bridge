import { describe, expect, it } from "vitest";

import { SessionTaskScheduler } from "../src/messageScheduler.js";

describe("SessionTaskScheduler", () => {
  it("runs different Weixin sessions in parallel up to the global limit", async () => {
    const scheduler = new SessionTaskScheduler(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all([
      scheduler.schedule("session-a", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
      }),
      scheduler.schedule("session-b", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
      })
    ]);

    expect(maxActive).toBe(2);
  });

  it("keeps messages from the same Weixin session in FIFO order", async () => {
    const scheduler = new SessionTaskScheduler(2);
    const events: string[] = [];

    await Promise.all([
      scheduler.schedule("same-session", async () => {
        events.push("first:start");
        await sleep(20);
        events.push("first:end");
      }),
      scheduler.schedule("same-session", async () => {
        events.push("second:start");
        events.push("second:end");
      })
    ]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
