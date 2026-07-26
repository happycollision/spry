import { test, expect, describe } from "bun:test";
import { classifyDrift } from "../../src/git/drift.ts";

describe("classifyDrift", () => {
  test("clean: local matches both references", () => {
    const d = classifyDrift({ localTip: "aaa", syncedHeadSha: "aaa", remoteTrackingTip: "aaa" });
    expect(d).toEqual({ localAhead: false, remoteAhead: false });
  });

  test("local-ahead: local differs from synced only", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: "aaa", remoteTrackingTip: "bbb" });
    expect(d).toEqual({ localAhead: true, remoteAhead: false });
  });

  test("remote-ahead: local differs from tracking only", () => {
    const d = classifyDrift({ localTip: "aaa", syncedHeadSha: "aaa", remoteTrackingTip: "zzz" });
    expect(d).toEqual({ localAhead: false, remoteAhead: true });
  });

  test("diverged: local differs from both", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: "aaa", remoteTrackingTip: "zzz" });
    expect(d).toEqual({ localAhead: true, remoteAhead: true });
  });

  test("unknown syncedHeadSha suppresses localAhead", () => {
    const d = classifyDrift({
      localTip: "bbb",
      syncedHeadSha: undefined,
      remoteTrackingTip: "zzz",
    });
    expect(d).toEqual({ localAhead: false, remoteAhead: true });
  });

  test("unknown remoteTrackingTip suppresses remoteAhead", () => {
    const d = classifyDrift({
      localTip: "bbb",
      syncedHeadSha: "aaa",
      remoteTrackingTip: undefined,
    });
    expect(d).toEqual({ localAhead: true, remoteAhead: false });
  });

  test("both references unknown: nothing", () => {
    const d = classifyDrift({
      localTip: "bbb",
      syncedHeadSha: undefined,
      remoteTrackingTip: undefined,
    });
    expect(d).toEqual({ localAhead: false, remoteAhead: false });
  });
});
