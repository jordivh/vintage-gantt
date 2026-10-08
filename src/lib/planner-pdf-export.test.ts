/**
 * Exporting the plan as a PDF.
 *
 * The export must produce a real file, hand it to the browser in the same click,
 * name it after the project and the date, and never claim "Export ready" for a
 * file that does not exist. These cases pin exactly that down: the file name, the
 * file itself (a PDF that pdf-lib can open again, holding the Gantt chart and no
 * task list), the rows the chart covers, the download that starts, the released
 * temporary file, and the error path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { createDefaultCalendarSystem, type CalendarSystem } from "./scheduling-engine";
import type { PlannerTask } from "./planner-model";
import { PDF_NO_TASKS_MESSAGE, buildPlannerPdfModel, plannerPdfFileName } from "./planner-pdf";
import { createPlannerPdfFile, releasePlannerPdfFile, startPdfDownload, type PlannerPdfFile } from "./planner-pdf-document";

/* -------------------------------------------------------------- fixtures */

const system: CalendarSystem = createDefaultCalendarSystem();

const task = (over: Partial<PlannerTask> & { id: string; start: string; finish: string }): PlannerTask => ({
  parentId: null,
  name: over.id,
  duration: 2,
  durationUnit: "days",
  isMilestone: false,
  predecessors: "",
  resource: "",
  percent: 0,
  notes: "",
  color: "sage",
  marginPct: 0,
  work: 16,
  ...over,
} as PlannerTask);

/** A small project: a summary with three children and a milestone. */
const smallProject = (): PlannerTask[] => [
  task({ id: "S", name: "Site works", duration: 8, start: "2026-10-05", finish: "2026-10-14", work: 64 }),
  task({ id: "S1", parentId: "S", name: "Site preparation", duration: 3, start: "2026-10-05", finish: "2026-10-07", work: 24 }),
  task({ id: "S2", parentId: "S", name: "Foundations", duration: 3, start: "2026-10-08", finish: "2026-10-12", work: 24, predecessors: "S1FS" }),
  task({ id: "S3", parentId: "S", name: "Drainage", duration: 2, start: "2026-10-13", finish: "2026-10-14", work: 16, predecessors: "S2FS" }),
  task({ id: "M", name: "Handover", duration: 0, start: "2026-10-16", finish: "2026-10-16", isMilestone: true, work: 0, predecessors: "S3FS" }),
];

/** The largest project of the planner: 249 tasks in one outline. */
const largestProject = (count = 249): PlannerTask[] => {
  const tasks: PlannerTask[] = [task({
    id: "P0", name: "Main works", duration: count * 2, start: "2026-10-05", finish: "2028-01-01", work: count * 16,
  })];
  for (let index = 1; index <= count; index += 1) {
    tasks.push(task({
      id: `T${index}`,
      parentId: "P0",
      name: `Work package ${index}`,
      duration: 3,
      start: "2026-10-05",
      finish: "2026-10-07",
      work: 24,
      predecessors: index > 1 ? `T${index - 1}FS` : "",
    }));
  }
  return tasks;
};

const inputFor = (tasks: PlannerTask[], over: Partial<Parameters<typeof buildPlannerPdfModel>[0]> = {}) => ({
  projectCode: "P26032",
  projectName: "Jackon Insulation",
  client: "Jackon",
  versionName: "Planning",
  mode: "planning" as const,
  baselineName: null,
  exportDate: "2026-10-08",
  today: "2026-10-08",
  tasks,
  assignments: tasks.map((item) => ({ taskId: item.id, resourceId: "res-anna" })),
  resources: [{ id: "res-anna", name: "Anna" }],
  system,
  projectCalendarId: system.defaultCalendarId,
  ...over,
});

/**
 * Every stream the file really holds, inflated: the check is on the document's
 * own drawing commands, never on the layout model that produced them.
 */
const pdfStreams = (bytes: Uint8Array): string[] => {
  const buffer = Buffer.from(bytes);
  const raw = buffer.toString("latin1");
  const streams: string[] = [];
  const marker = "stream\n";
  let index = 0;
  while ((index = raw.indexOf(marker, index)) !== -1) {
    // `endstream` contains `stream`: only a real stream head counts, or the scan
    // would stop after the first page.
    if (raw.slice(index - 3, index) === "end") {
      index += marker.length;
      continue;
    }
    const start = index + marker.length;
    // The stream's own `/Length` says exactly where it ends; a compressed blob
    // may contain the bytes "stream" itself, so scanning for `endstream` is not
    // reliable and would silently lose the pages behind it.
    const declared = raw.slice(Math.max(0, index - 160), index).match(/\/Length (\d+)/);
    const end = declared ? start + Number(declared[1]) : raw.indexOf("endstream", start);
    if (end <= start) break;
    const chunk = buffer.subarray(start, end);
    try {
      streams.push(inflateSync(chunk).toString("latin1"));
    } catch {
      // A stream that is not deflated is already readable as it stands; the
      // cross-reference one simply holds nothing to match.
      streams.push(chunk.toString("latin1"));
    }
    index = end;
  }
  return streams;
};

/** The text one stream really draws: every hex string pdf-lib wrote, decoded. */
const drawnText = (stream: string): string => {
  const lines: string[] = [];
  for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    const hex = match[1];
    let text = "";
    for (let at = 0; at + 1 < hex.length; at += 2) text += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2), 16));
    lines.push(text);
  }
  return lines.join("\n");
};

/** Everything the document draws as text, in file order. */
const pdfText = (bytes: Uint8Array): string => pdfStreams(bytes).map(drawnText).join("\n");

interface RenderedPage {
  /** The page number the page's own footer prints. */
  number: number;
  /** What the page draws as text, one drawn string per line. */
  text: string;
  /** The page's drawing commands, for the shapes that carry no text. */
  stream: string;
}

/**
 * The pages of a rendered document, found by the page number printed in their
 * footer — a page is identified by what a reader sees, not by object order. A
 * stream that prints no page number is not a page of this export.
 */
const pdfPages = (bytes: Uint8Array): { total: number; pages: Map<number, RenderedPage> } => {
  const pages = new Map<number, RenderedPage>();
  let total = 0;
  for (const stream of pdfStreams(bytes)) {
    const text = drawnText(stream);
    const printed = /Page (\d+) of (\d+)/.exec(text);
    if (!printed) continue;
    const number = Number(printed[1]);
    total = Number(printed[2]);
    pages.set(number, { number, text, stream });
  }
  return { total, pages };
};

/** The chart rows a page prints: the WBS number, then the task's name. */
const rowLabels = (text: string): string[] => text.split("\n").filter((line) => /^\d+(\.\d+)* {2}\S/.test(line));

/**
 * How often a colour is used in a stream: pdf-lib writes the channels as
 * decimal numbers followed by `rg` (fill) or `RG` (stroke), so counting the
 * triple counts the shapes of that colour.
 */
const countColour = (stream: string, hex: string): number => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const triple = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255).join(" ");
  return stream.split(triple).length - 1;
};

/** The planner's palette, as the renderer paints it. */
const PALETTE = { marginFill: "#eeddab", marginHatch: "#c9a86a", baseline: "#8d765a", link: "#1468c4" } as const;

/** A minimal DOM + object-URL recorder: enough to observe a real download start. */
const withFakeBrowser = <T>(run: (recorder: {
  hrefs: string[];
  names: string[];
  clicks: number;
  revoked: string[];
  created: number;
}) => Promise<T>): Promise<T> => {
  const recorder = { hrefs: [] as string[], names: [] as string[], clicks: 0, revoked: [] as string[], created: 0 };
  const globals = globalThis as unknown as { document?: unknown; URL: typeof URL };
  const previousDocument = globals.document;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  globals.document = {
    createElement: () => ({
      href: "",
      download: "",
      rel: "",
      style: {} as Record<string, string>,
      click() { recorder.clicks += 1; },
      remove() { /* detached again straight away */ },
    }),
    body: { appendChild: (node: { href: string; download: string }) => { recorder.hrefs.push(node.href); recorder.names.push(node.download); } },
  };
  URL.createObjectURL = () => {
    recorder.created += 1;
    return `blob:preview/${recorder.created}`;
  };
  URL.revokeObjectURL = (url: string) => { recorder.revoked.push(url); };
  return run(recorder).finally(() => {
    globals.document = previousDocument;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  });
};

/* ------------------------------------------------------------------ tests */

describe("PDF export — the file name", () => {
  test("is project code, project name and date, as one clear name", () => {
    expect(plannerPdfFileName("P26032", "Jackon Insulation", "2026-10-08"))
      .toBe("P26032 - Jackon Insulation - 2026-10-08.pdf");
  });

  test("leaves the code out when the project has none, and never loses the name", () => {
    expect(plannerPdfFileName("", "Jackon Insulation", "2026-10-08")).toBe("Jackon Insulation - 2026-10-08.pdf");
    expect(plannerPdfFileName("   ", "  ", "2026-10-08")).toBe("Project - 2026-10-08.pdf");
  });

  test("neutralises characters a file system would not accept", () => {
    expect(plannerPdfFileName("P/26", "Jackson: Insulation?", "2026-10-08"))
      .toBe("P 26 - Jackson Insulation - 2026-10-08.pdf");
  });

  test("the document is named after the file it comes from", () => {
    const model = buildPlannerPdfModel(inputFor(smallProject()));
    expect(model.fileName).toBe("P26032 - Jackon Insulation - 2026-10-08.pdf");
  });
});

describe("PDF export — the file that is created", () => {
  test("a small project becomes a real PDF holding the Gantt chart, and nothing else", async () => {
    const tasks = smallProject();
    const model = buildPlannerPdfModel(inputFor(tasks));
    expect(model.rows.length).toBe(tasks.length);
    expect(model.meta.summaryLine).toContain("5 tasks");
    expect(model.meta.summaryLine).toContain("1 milestone");

    const file = await createPlannerPdfFile(model);
    expect(file.bytes.length).toBeGreaterThan(1000);
    expect(file.blob.type).toBe("application/pdf");
    expect(file.blob.size).toBe(file.bytes.length);

    // The bytes really are a PDF, and it opens again with the same title.
    const reopened = await PDFDocument.load(file.bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getTitle()).toBe("Jackon Insulation - Planning");
    expect(reopened.getCreator()).toBe("Vintage GANTT");
    expect(reopened.getPage(0).getWidth()).toBeGreaterThan(100);
    expect(Buffer.from(file.bytes).toString("latin1").startsWith("%PDF-")).toBe(true);

    // The chart starts the document: the only page is page 1 of 1, and it is a
    // chart page.
    const { total, pages } = pdfPages(file.bytes);
    expect(total).toBe(1);
    expect([...pages.keys()]).toEqual([1]);
    const text = pages.get(1)?.text ?? "";

    // Every task of the plan is on the chart, with the milestone marked.
    for (const name of ["Site works", "Site preparation", "Foundations", "Drainage", "Handover"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("Handover (milestone)");

    // The chart's own content: the title with its date range, the six legend
    // entries, and the Today line.
    expect(/Gantt chart[^\n]*\d{1,2} [A-Za-z]+ \d{4} - \d{1,2} [A-Za-z]+ \d{4}/.test(text)).toBe(true);
    for (const legend of ["Critical path", "Summary bar", "Milestone", "Margin zone", "Baseline", "% complete"]) {
      expect(text).toContain(legend);
    }
    expect(text).toContain("Today");

    // The header of every page: project code, project name, client, then the
    // version, the mode, the active baseline and the export date.
    expect(text).toContain("P26032  ·  Jackon Insulation  ·  Jackon");
    expect(text).toContain("Version: Planning  ·  Mode: Planning  ·  Baseline active: No  ·  Export date: 8 Oct 2026");
    // The footer names the file, exactly as the download does, and numbers the page.
    expect(text).toContain("P26032 - Jackon Insulation - 2026-10-08.pdf");
    expect(text).toContain("Page 1 of 1");
  });

  test("the task list is gone from every page", async () => {
    const file = await createPlannerPdfFile(buildPlannerPdfModel(inputFor(smallProject())));
    const { total, pages } = pdfPages(file.bytes);
    expect(pages.size).toBe(total);
    for (const page of pages.values()) {
      // Every page of the export is a chart page…
      expect(page.text).toContain("Gantt chart");
      // …and none of them carries the removed table's title or its columns.
      expect(page.text).not.toContain("Task list");
      expect(page.text).not.toContain("Workload");
      expect(page.text).not.toContain("Assignee");
    }
    // Not one task-list heading survives anywhere in the document.
    expect(pdfText(file.bytes)).not.toContain("Task list");
  });

  test("the largest project (249 tasks) keeps every row, in time and without gaps", async () => {
    const tasks = largestProject();
    const model = buildPlannerPdfModel(inputFor(tasks));
    expect(model.rows.length).toBe(250);

    const started = performance.now();
    const file = await createPlannerPdfFile(model);
    const elapsed = performance.now() - started;

    const reopened = await PDFDocument.load(file.bytes);
    expect(reopened.getPageCount()).toBeGreaterThan(1);

    const { total, pages } = pdfPages(file.bytes);
    // The page numbers match the real total, with no gap and no repeat.
    expect(total).toBe(reopened.getPageCount());
    expect([...pages.keys()].sort((left, right) => left - right))
      .toEqual(Array.from({ length: total }, (_, index) => index + 1));

    // Every page is a chart page, and every one repeats the timeline header: a
    // day tick and a month band, plus the title's date range.
    for (const page of pages.values()) {
      expect(page.text).toContain("Gantt chart");
      expect(page.text).not.toContain("Task list");
      const lines = page.text.split("\n");
      expect(lines.some((line) => /^\d{2}\/\d{2}$/.test(line))).toBe(true);
      expect(lines.some((line) => /^[A-Z][a-z]{2,4} \d{4}$/.test(line))).toBe(true);
    }

    // The chart starts on page 1, which is the first part of the timeline.
    expect(pages.get(1)?.text).toContain("part 1 of ");
    // A plan this long needs continued row blocks and more than one window.
    const titled = [...pages.values()].map((page) => ({
      text: page.text,
      window: Number(/\bpart (\d+) of /.exec(page.text)?.[1] ?? 1),
      block: /\brows (\d+) onwards\b/.exec(page.text)?.[1] ?? "1",
    }));
    const blocks = [...new Set(titled.map((entry) => entry.block))];
    const windows = [...new Set(titled.map((entry) => entry.window))].sort((left, right) => left - right);
    expect(blocks.length).toBeGreaterThan(1);
    expect(windows.length).toBeGreaterThan(1);
    expect(titled.some((entry) => entry.text.includes("(continued)"))).toBe(true);

    // Within one window, a row block's pages hold that block's rows exactly
    // once, in the same order — and every window of the block shows the same
    // rows, so nothing is lost or repeated between pages.
    const drawn: string[] = [];
    for (const block of blocks) {
      const perWindow = windows.map((window) => titled
        .filter((entry) => entry.block === block && entry.window === window)
        .flatMap((entry) => rowLabels(entry.text)));
      for (const rows of perWindow) {
        expect(new Set(rows).size).toBe(rows.length);
        expect(rows).toEqual(perWindow[0]);
      }
      drawn.push(...perWindow[0]);
    }

    // Every task of the plan is drawn exactly once per window: none is missing
    // from the chart, and none is printed twice.
    const expected = model.rows.map((row) => `${row.wbs}  ${row.name}`);
    expect(expected.length).toBe(250);
    expect(drawn.length).toBe(expected.length);
    expect(new Set(drawn).size).toBe(drawn.length);
    for (const label of expected) expect(drawn).toContain(label);
    // Reported, not asserted tightly: a huge plan must render quickly, and the
    // buffer below is far above what this takes today.
    expect(elapsed).toBeLessThan(30_000);
  });

  test("the margin zones, the baseline bars and the dependency arrows are still drawn", async () => {
    const tasks = smallProject();
    const withReserves = tasks.map((item) => ({ ...item, marginPct: 25, marginDaysOriginal: 4, marginDaysConsumed: 1 }));
    const chartPage = async (bytes: Uint8Array) => pdfPages(bytes).pages.get(1)?.stream ?? "";

    // The legend draws one symbol of each kind on page 1, so a page only shows
    // more of a colour when the chart itself draws that element.
    const plain = await chartPage((await createPlannerPdfFile(buildPlannerPdfModel(inputFor(tasks)))).bytes);
    const reserves = await chartPage((await createPlannerPdfFile(buildPlannerPdfModel(inputFor(withReserves)))).bytes);
    expect(countColour(reserves, PALETTE.marginFill)).toBeGreaterThan(countColour(plain, PALETTE.marginFill));
    expect(countColour(reserves, PALETTE.marginHatch)).toBeGreaterThan(countColour(plain, PALETTE.marginHatch));

    const baseline = await chartPage((await createPlannerPdfFile(buildPlannerPdfModel(inputFor(withReserves, {
      baselineName: "Baseline 1",
      baselineTasks: tasks.map((item) => ({ taskId: item.id, startDate: item.start, finishDate: item.finish })),
    })))).bytes);
    expect(countColour(baseline, PALETTE.baseline)).toBeGreaterThan(countColour(reserves, PALETTE.baseline));

    const unlinked = await chartPage((await createPlannerPdfFile(buildPlannerPdfModel(inputFor(
      tasks.map((item) => ({ ...item, predecessors: "" })),
    )))).bytes);
    expect(countColour(plain, PALETTE.link)).toBeGreaterThan(countColour(unlinked, PALETTE.link));
  });

  test("an empty project still produces a valid file: one chart page and no table", async () => {
    const model = buildPlannerPdfModel(inputFor([]));
    expect(model.empty).toBe(true);
    const file = await createPlannerPdfFile(model);
    const reopened = await PDFDocument.load(file.bytes);
    expect(reopened.getPageCount()).toBe(1);
    const { total, pages } = pdfPages(file.bytes);
    expect(total).toBe(1);
    const text = pages.get(1)?.text ?? "";
    expect(text).toContain("Gantt chart");
    expect(text).toContain(PDF_NO_TASKS_MESSAGE);
    expect(text).not.toContain("Task list");
    expect(text).toContain("Page 1 of 1");
  });
});

describe("PDF export — the download and its temporary file", () => {
  test("the download starts immediately, with the file's own name", async () => {
    const model = buildPlannerPdfModel(inputFor(smallProject()));
    await withFakeBrowser(async (browser) => {
      const file = await createPlannerPdfFile(model);
      expect(browser.created).toBe(1);

      startPdfDownload(file);
      expect(browser.clicks).toBe(1);
      expect(browser.hrefs).toEqual([file.url]);
      expect(browser.names).toEqual(["P26032 - Jackon Insulation - 2026-10-08.pdf"]);

      // "Download PDF" downloads the very same file again, from the same URL.
      startPdfDownload(file);
      expect(browser.clicks).toBe(2);
      expect(browser.created).toBe(1);
    });
  });

  test("the temporary file is released once it is done, so memory does not grow", async () => {
    const model = buildPlannerPdfModel(inputFor(smallProject()));
    await withFakeBrowser(async (browser) => {
      const file = await createPlannerPdfFile(model);
      startPdfDownload(file);
      expect(browser.revoked).toEqual([]);

      releasePlannerPdfFile(file);
      expect(browser.revoked).toEqual([file.url]);

      // A second export creates a fresh URL, and releasing the first never
      // touches the second.
      const second = await createPlannerPdfFile(model);
      expect(second.url).not.toBe(file.url);
      expect(browser.created).toBe(2);
      releasePlannerPdfFile(second);
      expect(browser.revoked).toEqual([file.url, second.url]);
    });
  });

  test("a browser that cannot hand the file over fails loudly, so no false \"ready\" appears", async () => {
    const model = buildPlannerPdfModel(inputFor(smallProject()));
    const previousCreate = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error("blocked"); };
    let failure = "";
    try {
      await createPlannerPdfFile(model);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      URL.createObjectURL = previousCreate;
    }
    // The page turns this into "Export failed: …" instead of "Export ready".
    expect(failure).toContain("cannot hand it over for download");
  });
});

describe("PDF export — how the planner wires it up", () => {
  const dashboard = () => readFileSync("src/pages/Dashboard.tsx", "utf8");

  test("the Export button builds the file and starts the download", () => {
    const page = dashboard();
    expect(page).toContain('onClick={() => void runExport()}');
    expect(page).toContain("await createPlannerPdfFile(model)");
    expect(page).toContain("startPdfDownload(file)");
    // The old placeholder that reported a download that never happened is gone.
    expect(page).not.toContain('toast("Export ready")');
  });

  test("the message only appears with the file, offers a manual download, and errors are shown", () => {
    const page = dashboard();
    const readyIndex = page.indexOf('toast.success("Export ready"');
    const createIndex = page.indexOf("await createPlannerPdfFile(model)");
    // "Export ready" comes after the file exists…
    expect(createIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(createIndex);
    // …and carries the manual download plus the name of the file.
    expect(page).toContain('label: "Download PDF"');
    expect(page).toContain("description: file.fileName");
    // A failed export says so instead.
    expect(page).toContain("Export failed:");
    expect(page).toContain("toast.error(");
  });

  test("the temporary file is released when the message is gone and when the export changes", () => {
    const page = dashboard();
    expect(page).toContain("onDismiss: releaseExportFile");
    expect(page).toContain("onAutoClose: releaseExportFile");
    expect(page).toContain("releasePlannerPdfFile(exportFile.current)");
  });
});
