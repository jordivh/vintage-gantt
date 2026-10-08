/**
 * Exporting the plan as a PDF.
 *
 * The export must produce a real file, hand it to the browser in the same click,
 * name it after the project and the date, and never claim "Export ready" for a
 * file that does not exist. These cases pin exactly that down: the file name, the
 * file itself (a PDF that pdf-lib can open again, with the plan's content), the
 * download that starts, the released temporary file, and the error path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { createDefaultCalendarSystem, type CalendarSystem } from "./scheduling-engine";
import type { PlannerTask } from "./planner-model";
import { buildPlannerPdfModel, plannerPdfFileName } from "./planner-pdf";
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

/** The largest project of the planner: 245 tasks in one outline. */
const largestProject = (count = 245): PlannerTask[] => {
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
 * The text a PDF really holds. Every stream is inflated, and the hex strings
 * pdf-lib writes are decoded, so the check is on the document's own drawing
 * commands and not on the layout model that produced them.
 */
const pdfText = (bytes: Uint8Array): string => {
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
  const decoded: string[] = [];
  for (const stream of streams) {
    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const hex = match[1];
      let text = "";
      for (let at = 0; at + 1 < hex.length; at += 2) text += String.fromCharCode(Number.parseInt(hex.slice(at, at + 2), 16));
      decoded.push(text);
    }
  }
  return decoded.join("\n");
};

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
  test("a small project becomes a real PDF with the plan's content", async () => {
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
    expect(reopened.getPageCount()).toBeGreaterThan(0);
    expect(reopened.getTitle()).toBe("Jackon Insulation - Planning");
    expect(reopened.getCreator()).toBe("Vintage GANTT");
    expect(reopened.getPage(0).getWidth()).toBeGreaterThan(100);

    // The plan's own figures are in the document, not only in the model.
    expect(Buffer.from(file.bytes).toString("latin1").startsWith("%PDF-")).toBe(true);
    const text = pdfText(file.bytes);
    expect(text).toContain("Site preparation");
    expect(text).toContain("Foundations");
    expect(text).toContain("Handover");
    expect(text).toContain("Task list");
    // The footer names the file, exactly as the download does.
    expect(text).toContain("P26032 - Jackon Insulation - 2026-10-08.pdf");
  });

  test("the largest project (245 tasks) becomes a complete, multi-page PDF in time", async () => {
    const tasks = largestProject();
    const model = buildPlannerPdfModel(inputFor(tasks));
    expect(model.rows.length).toBe(246);

    const started = performance.now();
    const file = await createPlannerPdfFile(model);
    const elapsed = performance.now() - started;

    const reopened = await PDFDocument.load(file.bytes);
    expect(reopened.getPageCount()).toBeGreaterThan(1);
    // Every page names the file and counts itself: the document is complete.
    const text = pdfText(file.bytes);
    expect(text).toContain("Page 1 of ");
    expect(text).toContain(`Page ${reopened.getPageCount()} of ${reopened.getPageCount()}`);
    expect(text).toContain("Work package 1");
    expect(text).toContain("Work package 245");
    // Reported, not asserted tightly: a huge plan must render quickly, and the
    // buffer below is far above what this takes today.
    expect(elapsed).toBeLessThan(30_000);
  });

  test("an empty project still produces a valid file rather than nothing", async () => {
    const model = buildPlannerPdfModel(inputFor([]));
    expect(model.empty).toBe(true);
    const file = await createPlannerPdfFile(model);
    const reopened = await PDFDocument.load(file.bytes);
    expect(reopened.getPageCount()).toBe(1);
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
