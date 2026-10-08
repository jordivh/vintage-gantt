/**
 * The "Fixed date" selection of the optimization settings dialog.
 *
 * The dialog is opened before every optimization run. Opening it — and cancelling
 * it — must change nothing at all, while running the optimization remembers the
 * selection per project and pre-fills it the next time. These cases pin that down
 * without a browser: the store is injected, so every read and write is observed.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXED_MILESTONES_STORAGE_KEY,
  fixedMilestoneChoices,
  loadFixedMilestones,
  saveFixedMilestones,
  type MilestoneSelectionStore,
} from "./optimize-milestones";
import type { PlannerTask } from "./planner-model";

/** A stand-in for localStorage that records everything it is asked to do. */
const fakeStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: { key: string; value: string }[] = [];
  const store: MilestoneSelectionStore = {
    getItem(key) {
      reads.push(key);
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push({ key, value });
      data.set(key, value);
    },
  };
  return {
    store,
    reads,
    writes,
    snapshot: () => JSON.stringify([...data.entries()].sort()),
    /** Simulates a browser that refuses to store anything. */
    blocked: (): MilestoneSelectionStore => ({
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    }),
  };
};

const milestone = (id: string, date: string): PlannerTask => ({
  id,
  parentId: null,
  name: `Milestone ${id}`,
  duration: 0,
  durationUnit: "days",
  start: date,
  finish: date,
  isMilestone: true,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
} as PlannerTask);

describe("fixed milestone selection", () => {
  test("is remembered per project and pre-filled the next time the dialog opens", () => {
    const { store } = fakeStore();

    // Nothing ticked yet: a project that was never optimized remembers nothing.
    expect(loadFixedMilestones("proj-a", store)).toEqual([]);

    // Run the optimization with two milestones fixed…
    saveFixedMilestones("proj-a", ["m-2", "m-1"], store);
    // …and open the dialog again: exactly those boxes come back ticked.
    expect(loadFixedMilestones("proj-a", store)).toEqual(["m-2", "m-1"]);

    // A second project keeps its own selection.
    saveFixedMilestones("proj-b", ["m-9"], store);
    expect(loadFixedMilestones("proj-b", store)).toEqual(["m-9"]);
    expect(loadFixedMilestones("proj-a", store)).toEqual(["m-2", "m-1"]);

    // Un-ticking everything is remembered too, as an empty selection.
    saveFixedMilestones("proj-a", [], store);
    expect(loadFixedMilestones("proj-a", store)).toEqual([]);
    expect(loadFixedMilestones("proj-b", store)).toEqual(["m-9"]);
  });

  test("cancelling the dialog changes nothing, in the store or in the plan", () => {
    const { store, writes, snapshot } = fakeStore();
    saveFixedMilestones("proj-a", ["m-1"], store);
    const before = snapshot();
    const writesBefore = writes.length;

    const milestones = [milestone("m-1", "2026-10-09"), milestone("m-2", "2026-10-16")];
    const planBefore = JSON.stringify(milestones);
    // The dialog's own flow: open it, change the boxes locally, cancel or run.
    const openDialog = () => fixedMilestoneChoices(milestones, loadFixedMilestones("proj-a", store));
    const toggle = (choices: ReturnType<typeof openDialog>, taskId: string) =>
      choices.map((choice) => (choice.taskId === taskId ? { ...choice, fixed: !choice.fixed } : choice));
    const cancel = () => { /* Cancel writes nothing: it only closes the dialog. */ };
    const runOptimization = (choices: ReturnType<typeof openDialog>) =>
      saveFixedMilestones("proj-a", choices.filter((choice) => choice.fixed).map((choice) => choice.taskId), store);

    // Opening the dialog pre-fills the remembered selection.
    expect(openDialog().map((choice) => [choice.taskId, choice.fixed])).toEqual([["m-1", true], ["m-2", false]]);
    // The boxes are changed to m-2 only, and then Cancel is pressed.
    const draft = toggle(toggle(openDialog(), "m-1"), "m-2");
    expect(draft.filter((choice) => choice.fixed).map((choice) => choice.taskId)).toEqual(["m-2"]);
    cancel();

    // Nothing was written, the remembered selection is the old one, and the
    // project's milestones are exactly as they were.
    expect(writes.length).toBe(writesBefore);
    expect(snapshot()).toBe(before);
    expect(JSON.stringify(milestones)).toBe(planBefore);
    expect(loadFixedMilestones("proj-a", store)).toEqual(["m-1"]);

    // "Run optimization" is what remembers the draft.
    runOptimization(draft);
    expect(loadFixedMilestones("proj-a", store)).toEqual(["m-2"]);
  });

  test("lists every milestone of the open project, in plan order", () => {
    const milestones = [milestone("late", "2026-10-16"), milestone("early", "2026-10-09"), milestone("middle", "2026-10-12")];
    expect(fixedMilestoneChoices(milestones, ["early", "late"]).map((choice) => [choice.taskId, choice.date, choice.fixed])).toEqual([
      ["early", "2026-10-09", true],
      ["middle", "2026-10-12", false],
      ["late", "2026-10-16", true],
    ]);
    // A remembered id that is no longer a milestone gets no row, and ticking an
    // unknown id cannot pre-tick anything.
    expect(fixedMilestoneChoices([milestone("early", "2026-10-09")], ["gone"]).map((choice) => choice.fixed)).toEqual([false]);
    expect(fixedMilestoneChoices([], ["early"])).toEqual([]);
  });

  test("a browser without working storage simply remembers nothing", () => {
    const { blocked } = fakeStore();
    // Both a throwing store and no store at all are absorbed, never propagated.
    expect(loadFixedMilestones("proj-a", blocked())).toEqual([]);
    expect(saveFixedMilestones("proj-a", ["m-1"], blocked())).toBeUndefined();
    expect(loadFixedMilestones("proj-a", null)).toEqual([]);
    expect(saveFixedMilestones("proj-a", ["m-1"], null)).toBeUndefined();
  });

  test("unreadable or foreign storage is treated as nothing remembered", () => {
    for (const raw of ["not json", "[]", '"text"', "null", "{\"proj-a\":\"nope\"}"]) {
      const { store } = fakeStore({ [FIXED_MILESTONES_STORAGE_KEY]: raw });
      expect(loadFixedMilestones("proj-a", store)).toEqual([]);
    }
    // A stored object with a list under the project is read as-is.
    const { store } = fakeStore({ [FIXED_MILESTONES_STORAGE_KEY]: JSON.stringify({ "proj-a": ["m-1", 7], "proj-b": ["m-2"] }) });
    expect(loadFixedMilestones("proj-a", store)).toEqual(["m-1"]);
    expect(loadFixedMilestones("proj-b", store)).toEqual(["m-2"]);
  });
});
