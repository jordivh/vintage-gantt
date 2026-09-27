import { describe, expect, test } from "bun:test";
import { removeBaselineAndSnapshots, type BaselineRecord, type BaselineSnapshotRecord } from "./planner-model";

interface Snapshot extends BaselineSnapshotRecord {
  id: string;
  taskId: string;
}

const baseline = (id: string, versionId: string, createdAt: string): BaselineRecord => ({ id, versionId, createdAt });
const snapshot = (id: string, baselineId: string, taskId: string): Snapshot => ({ id, baselineId, taskId });

describe("baseline deletion", () => {
  test("removes the baseline and every snapshot stored for it", () => {
    const baselines = [baseline("b1", "v1", "2026-09-01T10:00:00.000Z")];
    const snapshots = [snapshot("s1", "b1", "t1"), snapshot("s2", "b1", "t2")];
    const removal = removeBaselineAndSnapshots(baselines, snapshots, "b1");
    expect(removal).not.toBeNull();
    expect(removal!.baselines).toEqual([]);
    expect(removal!.snapshots).toEqual([]);
    expect(removal!.snapshotsRemoved).toBe(2);
    expect(removal!.fallbackBaselineId).toBe("");
  });

  test("keeps the snapshots of the baselines that stay", () => {
    const baselines = [baseline("b1", "v1", "2026-09-01T10:00:00.000Z"), baseline("b2", "v1", "2026-09-10T10:00:00.000Z")];
    const snapshots = [snapshot("s1", "b1", "t1"), snapshot("s2", "b2", "t1"), snapshot("s3", "b2", "t2")];
    const removal = removeBaselineAndSnapshots(baselines, snapshots, "b1");
    expect(removal!.baselines.map((item) => item.id)).toEqual(["b2"]);
    expect(removal!.snapshots.map((item) => item.id)).toEqual(["s2", "s3"]);
    expect(removal!.snapshotsRemoved).toBe(1);
  });

  test("sweeps snapshot rows that were already orphaned, so nothing can be left behind", () => {
    const baselines = [baseline("b1", "v1", "2026-09-01T10:00:00.000Z")];
    const snapshots = [snapshot("s1", "b1", "t1"), snapshot("s-orphan", "gone", "t2")];
    const removal = removeBaselineAndSnapshots(baselines, snapshots, "b1");
    expect(removal!.snapshots).toEqual([]);
    expect(removal!.snapshotsRemoved).toBe(2);
  });

  test("falls back to the most recent baseline left on the same plan version", () => {
    const baselines = [
      baseline("b1", "v1", "2026-09-20T10:00:00.000Z"),
      baseline("b2", "v1", "2026-09-05T10:00:00.000Z"),
      baseline("b3", "v1", "2026-09-12T10:00:00.000Z"),
    ];
    const removal = removeBaselineAndSnapshots(baselines, [], "b1");
    expect(removal!.fallbackBaselineId).toBe("b3");
  });

  test("never falls back across plan versions", () => {
    const baselines = [baseline("b1", "v1", "2026-09-20T10:00:00.000Z"), baseline("b2", "v2", "2026-09-01T10:00:00.000Z")];
    const removal = removeBaselineAndSnapshots(baselines, [], "b1");
    expect(removal!.fallbackBaselineId).toBe("");
    expect(removal!.baselines.map((item) => item.id)).toEqual(["b2"]);
  });

  test("reports a baseline that is not there instead of pretending it worked", () => {
    expect(removeBaselineAndSnapshots([baseline("b1", "v1", "2026-09-01T10:00:00.000Z")], [], "missing")).toBeNull();
    expect(removeBaselineAndSnapshots([], [], "")).toBeNull();
  });

  test("only reports baselines and snapshots: planning data is never part of the removal", () => {
    const tasks = [{ id: "t1", duration: 5, marginDaysConsumed: 1, marginDaysOriginal: 1 }];
    const before = JSON.stringify(tasks);
    const removal = removeBaselineAndSnapshots([baseline("b1", "v1", "2026-09-01T10:00:00.000Z")], [snapshot("s1", "b1", "t1")], "b1");
    expect(Object.keys(removal!).sort()).toEqual(["baselines", "fallbackBaselineId", "snapshots", "snapshotsRemoved"]);
    expect(JSON.stringify(tasks)).toBe(before);
  });
});
