import type { PDFFont, PDFPage } from "pdf-lib";
import {
  DEFAULT_INCLUDE_GANTT,
  DEFAULT_ORIENTATION,
  DEFAULT_PAPER,
  PDF_NO_TASKS_MESSAGE,
  PDF_SECTION_TITLES,
  PDF_TABLE_HEADERS,
  chartWindows,
  chunkRows,
  formatPdfDate,
  formatPdfMonth,
  formatPdfTick,
  pageGeometry,
  pdfSafeText,
  tickEveryDays,
  type PdfChartWindow,
  type PdfOrientation,
  type PdfPaper,
  type PlannerPdfModel,
  type PlannerPdfRow,
} from "./planner-pdf";

/* --------------------------------------------------------------------------
 * Planner PDF renderer
 *
 * Pure layout: the model already holds every figure and day offset, so this
 * file only decides where the ink goes. pdf-lib is loaded on demand, and it is
 * the same library in the browser and in Node, so the export can be rendered
 * and inspected outside the browser as well.
 *
 * Nothing here can touch the plan: it draws what the model read.
 * ------------------------------------------------------------------------ */

export interface PlannerPdfOptions {
  paper?: PdfPaper;
  orientation?: PdfOrientation;
  includeGantt?: boolean;
}

const PT_PER_MM = 72 / 25.4;
/** Millimetres to points, for pdf-lib. */
const mm = (value: number) => value * PT_PER_MM;

/* ------------------------------------------------------------------ layout */

const MARGIN_X = 12;
const HEADER_H = 24;
const FOOTER_H = 12;
const SECTION_TITLE_H = 9;
const LEGEND_H = 9;
const TABLE_HEADER_H = 7;
const TABLE_ROW_H = 6.4;
const CHART_ROW_H = 7;
const CHART_TICK_BAND = 9;
const CHART_GAP = 2;
/** Both chart axes paginate, so this is the budget the two share. */
const CHART_PAGE_BUDGET = 30;

/** Table column widths as fractions of the usable width, in header order. */
const TABLE_COLUMNS = [0.05, 0.26, 0.085, 0.085, 0.07, 0.07, 0.14, 0.09, 0.1, 0.05];

/** The planner's own palette, so the print matches the screen. */
const PALETTE = {
  ink: "#49372a",
  inkSoft: "#6b5948",
  muted: "#8b765d",
  rule: "#c4b292",
  rowRule: "#e2d7c4",
  zebra: "#f7f1e6",
  summaryRow: "#efe7d8",
  headerFill: "#e4d8c3",
  nonWorking: "#78644a",
  summaryBar: "#806346",
  milestone: "#9b593e",
  critical: "#7d3f32",
  criticalEdge: "#542a22",
  marginFill: "#eeddab",
  marginHatch: "#c9a86a",
  baseline: "#8d765a",
  link: "#1468c4",
  today: "#a9533f",
  white: "#ffffff",
  barEdge: "#7a6244",
} as const;

/** Bar colours by the task's own colour key, exactly as the screen paints them. */
const BAR_COLOURS: Record<string, string> = {
  ochre: "#af8250",
  sage: "#75856c",
  clay: "#ad6650",
  ink: "#566b6b",
  rust: "#99513e",
};

type TextOptions = NonNullable<Parameters<PDFPage["drawText"]>[1]>;
type RectOptions = Omit<NonNullable<Parameters<PDFPage["drawRectangle"]>[0]>, "x" | "y" | "width" | "height">;
type LineOptions = Omit<NonNullable<Parameters<PDFPage["drawLine"]>[0]>, "start" | "end">;

/** Everything is laid out in millimetres from the page's top-left corner. */
interface Pen {
  text: (text: string, xMm: number, topMm: number, rowHeightMm: number, sizePt: number, font: PDFFont, colour?: TextOptions["color"]) => void;
  textAt: (text: string, xMm: number, baselineMm: number, sizePt: number, font: PDFFont, colour?: TextOptions["color"]) => void;
  rect: (xMm: number, topMm: number, widthMm: number, heightMm: number, options?: RectOptions) => void;
  line: (x1Mm: number, y1Mm: number, x2Mm: number, y2Mm: number, options?: LineOptions) => void;
}

export async function renderPlannerPdf(model: PlannerPdfModel, options: PlannerPdfOptions = {}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  // pdf-lib wants its own colour type, so the palette is built here, where the
  // library is actually loaded.
  const hex = (value: string) => {
    const n = Number.parseInt(value.replace("#", ""), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const INK = hex(PALETTE.ink);
  const INK_SOFT = hex(PALETTE.inkSoft);
  const MUTED = hex(PALETTE.muted);
  const RULE = hex(PALETTE.rule);
  const ROW_RULE = hex(PALETTE.rowRule);
  const ZEBRA = hex(PALETTE.zebra);
  const SUMMARY_ROW = hex(PALETTE.summaryRow);
  const HEADER_FILL = hex(PALETTE.headerFill);
  const NON_WORKING = hex(PALETTE.nonWorking);
  const SUMMARY_BAR = hex(PALETTE.summaryBar);
  const MILESTONE = hex(PALETTE.milestone);
  const CRITICAL = hex(PALETTE.critical);
  const CRITICAL_EDGE = hex(PALETTE.criticalEdge);
  const MARGIN_FILL = hex(PALETTE.marginFill);
  const MARGIN_HATCH = hex(PALETTE.marginHatch);
  const BASELINE = hex(PALETTE.baseline);
  const LINK = hex(PALETTE.link);
  const TODAY = hex(PALETTE.today);
  const WHITE = hex(PALETTE.white);
  const barColour = (key: string) => hex(BAR_COLOURS[key] ?? BAR_COLOURS.ochre);
  const paper = options.paper ?? DEFAULT_PAPER;
  const orientation = options.orientation ?? DEFAULT_ORIENTATION;
  const includeGantt = options.includeGantt ?? DEFAULT_INCLUDE_GANTT;
  const page = pageGeometry(paper, orientation);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  doc.setTitle(pdfSafeText(`${model.meta.projectName} - ${model.meta.versionName}`));
  doc.setSubject(pdfSafeText(`Project planning export ${model.meta.exportDate}`));
  doc.setCreator("Vintage GANTT");
  doc.setProducer("Vintage GANTT");

  const height = page.heightMm;
  const pageWidth = page.widthMm;
  const left = MARGIN_X;
  const usable = pageWidth - MARGIN_X * 2;
  const contentTop = HEADER_H;
  const usableHeight = height - FOOTER_H - contentTop;

  const pens: Pen[] = [];
  const newPage = () => {
    const sheet = doc.addPage([mm(pageWidth), mm(height)]);
    const pen: Pen = {
      text: (text, xMm, topMm, rowHeightMm, sizePt, textFont, colour = INK_SOFT) =>
        sheet.drawText(pdfSafeText(text), {
          x: mm(xMm),
          y: mm(height - (topMm + rowHeightMm / 2 + (sizePt / PT_PER_MM) * 0.25)),
          size: sizePt,
          font: textFont,
          color: colour,
        }),
      textAt: (text, xMm, baselineMm, sizePt, textFont, colour = INK_SOFT) =>
        sheet.drawText(pdfSafeText(text), { x: mm(xMm), y: mm(height - baselineMm), size: sizePt, font: textFont, color: colour }),
      rect: (xMm, topMm, widthMm, rectHeightMm, rectOptions = {}) =>
        sheet.drawRectangle({
          x: mm(xMm),
          y: mm(height - topMm - rectHeightMm),
          width: mm(Math.max(0, widthMm)),
          height: mm(Math.max(0, rectHeightMm)),
          ...rectOptions,
        }),
      line: (x1Mm, y1Mm, x2Mm, y2Mm, lineOptions = {}) =>
        sheet.drawLine({
          start: { x: mm(x1Mm), y: mm(height - y1Mm) },
          end: { x: mm(x2Mm), y: mm(height - y2Mm) },
          ...lineOptions,
        }),
    };
    pens.push(pen);
    return pen;
  };

  const widthOf = (text: string, sizePt: number, textFont: PDFFont = font) => textFont.widthOfTextAtSize(pdfSafeText(text), sizePt) / PT_PER_MM;

  /** Truncates to the available space, so a long name can never overlap its neighbour. */
  const fit = (text: string, maxWidthMm: number, sizePt: number, textFont: PDFFont = font) => {
    const value = pdfSafeText(text);
    if (maxWidthMm <= 0) return "";
    if (widthOf(value, sizePt, textFont) <= maxWidthMm) return value;
    let trimmed = value;
    while (trimmed.length > 1 && widthOf(`${trimmed}...`, sizePt, textFont) > maxWidthMm) trimmed = trimmed.slice(0, -1);
    return `${trimmed}...`;
  };

  const addDays = (date: string, amount: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + amount);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  };

  /* -------------------------------------------------------- table of tasks */

  const tableTitle = `${PDF_SECTION_TITLES.tasks} — ${model.meta.summaryLine}`;
  const rowsOnFirstTablePage = Math.max(1, Math.floor((usableHeight - SECTION_TITLE_H - TABLE_HEADER_H) / TABLE_ROW_H));
  const rowsOnNextTablePage = Math.max(1, Math.floor((usableHeight - TABLE_HEADER_H) / TABLE_ROW_H));

  const drawTableHeader = (pen: Pen, topMm: number) => {
    pen.rect(left, topMm, usable, TABLE_HEADER_H, { color: HEADER_FILL });
    let x = left;
    TABLE_COLUMNS.forEach((fraction, index) => {
      pen.text(PDF_TABLE_HEADERS[index] ?? "", x + 1.2, topMm, TABLE_HEADER_H, 8, bold, INK_SOFT);
      x += usable * fraction;
    });
    pen.line(left, topMm + TABLE_HEADER_H, left + usable, topMm + TABLE_HEADER_H, { color: RULE, thickness: mm(0.3) });
  };

  const drawTableRows = (pen: Pen, rows: PlannerPdfRow[], topMm: number) => {
    const widths = TABLE_COLUMNS.map((fraction) => usable * fraction);
    rows.forEach((row, index) => {
      const rowTop = topMm + index * TABLE_ROW_H;
      if (row.isSummary) pen.rect(left, rowTop, usable, TABLE_ROW_H, { color: SUMMARY_ROW });
      else if (index % 2 === 1) pen.rect(left, rowTop, usable, TABLE_ROW_H, { color: ZEBRA });
      const cells = [
        row.wbs,
        `${row.name}${row.isMilestone ? " (milestone)" : ""}`,
        formatPdfDate(row.start),
        formatPdfDate(row.finish),
        row.durationText,
        row.workText,
        row.assigneeText,
        row.statusText,
        row.marginText,
        row.isCritical ? "*" : "",
      ];
      let x = left;
      cells.forEach((cell, cellIndex) => {
        const cellWidth = widths[cellIndex] ?? 0;
        // The task name is the one cell that carries the outline hierarchy.
        const pad = (cellIndex === 1 ? 1.6 + row.depth * 3.4 : 1.2);
        const cellFont = row.isSummary ? bold : font;
        pen.text(fit(cell, cellWidth - pad - 1.6, 8, cellFont), x + pad, rowTop, TABLE_ROW_H, 8, cellFont, row.isSummary ? INK : INK_SOFT);
        x += cellWidth;
      });
      pen.line(left, rowTop + TABLE_ROW_H, left + usable, rowTop + TABLE_ROW_H, { color: ROW_RULE, thickness: mm(0.2) });
    });
  };

  if (model.empty) {
    const pen = newPage();
    pen.text(tableTitle, left, contentTop, SECTION_TITLE_H, 10.5, bold, INK);
    pen.text(PDF_NO_TASKS_MESSAGE, left, contentTop + SECTION_TITLE_H, 8, 9, italic, MUTED);
  } else {
    const tablePages: PlannerPdfRow[][] = [];
    tablePages.push(model.rows.slice(0, rowsOnFirstTablePage));
    for (let index = rowsOnFirstTablePage; index < model.rows.length; index += rowsOnNextTablePage) {
      tablePages.push(model.rows.slice(index, index + rowsOnNextTablePage));
    }
    tablePages.forEach((block, index) => {
      const pen = newPage();
      let top = contentTop;
      if (index === 0) {
        pen.text(fit(tableTitle, usable, 10.5, bold), left, top, SECTION_TITLE_H, 10.5, bold, INK);
        top += SECTION_TITLE_H;
      }
      drawTableHeader(pen, top);
      drawTableRows(pen, block, top + TABLE_HEADER_H);
    });
  }

  /* ------------------------------------------------------------ Gantt chart */

  /** A light 45° hatch, drawn inside the zone only: the screen's margin look. */
  const hatch = (pen: Pen, xMm: number, topMm: number, widthMm: number, zoneHeightMm: number) => {
    const step = 2.2;
    for (let offset = 0; offset <= widthMm; offset += step) {
      const fromX = xMm + offset;
      const startY = topMm + zoneHeightMm;
      const endX = Math.min(xMm + widthMm, fromX + zoneHeightMm);
      pen.line(fromX, startY, endX, startY - (endX - fromX), { color: MARGIN_HATCH, thickness: mm(0.2) });
    }
  };

  if (includeGantt && model.chart) {
    const chart = model.chart;
    const nameWidth = Math.min(84, Math.max(46, usable * 0.22));
    const timeWidth = usable - nameWidth - CHART_GAP;
    const chartLeft = left + nameWidth + CHART_GAP;
    const chartRight = chartLeft + timeWidth;
    const rowsPerChartPage = Math.max(1, Math.floor((usableHeight - SECTION_TITLE_H - CHART_TICK_BAND - LEGEND_H) / CHART_ROW_H));
    const rowBlocks = chunkRows(model.rows, rowsPerChartPage);
    // The two axes multiply, so the budget is shared between them: a row-heavy plan
    // gets a wider (scaled down) timeline instead of one page per period per block.
    const maxWindows = Math.max(1, Math.min(12, Math.floor(CHART_PAGE_BUDGET / Math.max(1, rowBlocks.length))));
    const layout = chartWindows(chart.totalDays, timeWidth, { minDayWidthMm: 1.2, maxWindows });
    const dayX = (day: number, window: PdfChartWindow) => chartLeft + (day - window.startDay) * layout.dayWidthMm;

    const drawLegend = (pen: Pen, topMm: number) => {
      let x = left;
      const size = 7;
      const symbol = 9;
      for (const item of model.legend) {
        const label = pdfSafeText(item.label);
        const itemWidth = symbol + widthOf(label, size) + 5;
        if (x + itemWidth > left + usable) break;
        const middle = topMm + LEGEND_H / 2;
        if (item.key === "critical") pen.rect(x, middle - 1.4, symbol - 2, 2.8, { color: CRITICAL, borderColor: CRITICAL_EDGE, borderWidth: mm(0.2) });
        else if (item.key === "summary") pen.rect(x, middle - 1.1, symbol - 2, 2.2, { color: SUMMARY_BAR });
        else if (item.key === "milestone") {
          pen.line(x + 2.6, middle - 1.6, x + 4.2, middle, { color: MILESTONE, thickness: mm(0.5) });
          pen.line(x + 4.2, middle, x + 2.6, middle + 1.6, { color: MILESTONE, thickness: mm(0.5) });
          pen.line(x + 2.6, middle + 1.6, x + 1, middle, { color: MILESTONE, thickness: mm(0.5) });
          pen.line(x + 1, middle, x + 2.6, middle - 1.6, { color: MILESTONE, thickness: mm(0.5) });
        } else if (item.key === "margin") {
          pen.rect(x, middle - 1.4, symbol - 2, 2.8, { color: MARGIN_FILL, borderColor: MARGIN_HATCH, borderWidth: mm(0.25), borderDashArray: [mm(1), mm(1)] });
        } else if (item.key === "baseline") pen.rect(x, middle + 0.4, symbol - 2, 1.1, { borderColor: BASELINE, borderWidth: mm(0.3) });
        else pen.rect(x, middle - 1.4, symbol - 2, 2.8, { color: barColour("ochre"), opacity: 0.6 });
        pen.text(label, x + symbol, topMm, LEGEND_H, size, font, INK_SOFT);
        x += itemWidth;
      }
    };

    const drawChartPage = (block: PlannerPdfRow[], window: PdfChartWindow, windowIndex: number, blockIndex: number) => {
      const pen = newPage();
      const first = blockIndex === 0 && windowIndex === 0;
      let top = contentTop;
      const from = formatPdfDate(addDays(chart.start, window.startDay));
      const to = formatPdfDate(addDays(chart.start, window.startDay + window.dayCount - 1));
      const pages = layout.windows.length;
      const parts = [
        `${PDF_SECTION_TITLES.chart}${first ? "" : " (continued)"}`,
        `${from} - ${to}`,
        pages > 1 ? `part ${windowIndex + 1} of ${pages}` : "",
        blockIndex > 0 ? `rows ${(block[0]?.rowIndex ?? 0) + 1} onwards` : "",
      ].filter(Boolean);
      pen.text(fit(parts.join(" — "), usable, 10.5, bold), left, top, SECTION_TITLE_H, 10.5, bold, INK);
      top += SECTION_TITLE_H;
      if (first) {
        drawLegend(pen, top);
        top += LEGEND_H;
      }

      const rowsTop = top + CHART_TICK_BAND;
      const rowsBottom = rowsTop + block.length * CHART_ROW_H;
      const monthBandTop = top;
      const tickBandTop = top + CHART_TICK_BAND / 2;
      const dayWidthMm = layout.dayWidthMm;

      // Month band, then the day ticks, then the frame around the rows.
      const months: { label: string; startDay: number; days: number }[] = [];
      for (let day = 0; day < window.dayCount; day += 1) {
        const monthKey = addDays(chart.start, window.startDay + day).slice(0, 7);
        const last = months[months.length - 1];
        if (last && last.label === monthKey) last.days += 1;
        else months.push({ label: monthKey, startDay: day, days: 1 });
      }
      for (const month of months) {
        const monthX = chartLeft + month.startDay * dayWidthMm;
        const monthWidth = month.days * dayWidthMm;
        if (monthWidth >= 12) {
          const label = formatPdfMonth(addDays(chart.start, window.startDay + month.startDay));
          pen.textAt(label, monthX + Math.max(0.6, (monthWidth - widthOf(label, 7, bold)) / 2), monthBandTop + 4, 7, bold, MUTED);
        }
        pen.line(monthX, monthBandTop, monthX, rowsBottom, { color: ROW_RULE, thickness: mm(0.2) });
      }
      const tickEvery = tickEveryDays(dayWidthMm);
      for (let day = 0; day < window.dayCount; day += 1) {
        const tickX = chartLeft + day * dayWidthMm;
        pen.line(tickX, tickBandTop, tickX, rowsBottom, { color: ROW_RULE, thickness: mm(0.15) });
        if (day % tickEvery === 0 && dayWidthMm >= 0.45) {
          pen.textAt(formatPdfTick(addDays(chart.start, window.startDay + day)), tickX + 0.6, tickBandTop + 3.4, 6.5, font, MUTED);
        }
      }
      pen.line(chartLeft, rowsTop, chartRight, rowsTop, { color: RULE, thickness: mm(0.3) });
      pen.line(chartLeft, rowsBottom, chartRight, rowsBottom, { color: RULE, thickness: mm(0.3) });
      pen.line(left + nameWidth, top, left + nameWidth, rowsBottom, { color: RULE, thickness: mm(0.4) });
      pen.line(chartRight, top, chartRight, rowsBottom, { color: RULE, thickness: mm(0.2) });

      for (const day of chart.nonWorkingDays) {
        if (day < window.startDay || day >= window.startDay + window.dayCount) continue;
        pen.rect(dayX(day, window), rowsTop, dayWidthMm, rowsBottom - rowsTop, { color: NON_WORKING, opacity: 0.09 });
      }
      block.forEach((row, index) => {
        const rowTop = rowsTop + index * CHART_ROW_H;
        if (index % 2 === 1) pen.rect(chartLeft, rowTop, timeWidth, CHART_ROW_H, { color: ZEBRA });
        const label = `${row.wbs}  ${row.name}${row.isMilestone ? " (milestone)" : ""}`;
        const labelFont = row.isSummary ? bold : font;
        pen.text(fit(label, nameWidth - 2.4 - row.depth * 2.4, 7.5, labelFont), left + 1 + row.depth * 2.4, rowTop, CHART_ROW_H, 7.5, labelFont, row.isSummary ? INK : INK_SOFT);
        pen.line(left, rowTop + CHART_ROW_H, chartRight, rowTop + CHART_ROW_H, { color: ROW_RULE, thickness: mm(0.15) });
      });

      // Dependency arrows first, so the bars sit on top of them. A link is drawn on
      // the page where both of its ends are visible.
      for (const link of model.links) {
        const predecessor = block.findIndex((row) => row.rowIndex === link.predecessorRow);
        const successor = block.findIndex((row) => row.rowIndex === link.successorRow);
        if (predecessor < 0 || successor < 0) continue;
        if (link.fromDay < window.startDay || link.toDay >= window.startDay + window.dayCount) continue;
        const x1 = dayX(link.fromDay, window);
        const x2 = dayX(link.toDay, window);
        const y1 = rowsTop + predecessor * CHART_ROW_H + CHART_ROW_H / 2;
        const y2 = rowsTop + successor * CHART_ROW_H + CHART_ROW_H / 2;
        const elbow = x2 >= x1 ? x1 + Math.max(3, (x2 - x1) * 0.55) : x1 + 3;
        const points: [number, number][] = x2 >= x1
          ? [[x1, y1], [elbow, y1], [elbow, y2], [x2, y2]]
          : [[x1, y1], [elbow, y1], [elbow, y2], [x2 - 2.4, y2], [x2, y2]];
        for (let index = 0; index < points.length - 1; index += 1) {
          pen.line(points[index][0], points[index][1], points[index + 1][0], points[index + 1][1], { color: LINK, thickness: mm(0.35) });
        }
        pen.line(x2, y2, x2 - 1.5, y2 - 0.9, { color: LINK, thickness: mm(0.35) });
        pen.line(x2, y2, x2 - 1.5, y2 + 0.9, { color: LINK, thickness: mm(0.35) });
      }

      // Bars, margin zones, baselines and milestones, all clipped to the page.
      block.forEach((row, index) => {
        const rowTop = rowsTop + index * CHART_ROW_H;
        const barTop = rowTop + 1.5;
        const barHeight = 3.4;
        const clip = (startMm: number, widthMm: number) => {
          const from = Math.max(chartLeft, startMm);
          const to = Math.min(chartRight, startMm + widthMm);
          return { from, width: Math.max(0, to - from) };
        };
        if (row.baseline) {
          const bar = clip(dayX(row.baseline.startDay, window), row.baseline.days * dayWidthMm);
          if (bar.width > 0) pen.rect(bar.from, rowTop + 5.2, bar.width, 1.1, { borderColor: BASELINE, borderWidth: mm(0.3) });
        }
        if (row.marginDays > 0) {
          const zone = clip(dayX(row.barStartDay + row.barDays, window), row.marginDays * dayWidthMm);
          if (zone.width > 0.4) {
            pen.rect(zone.from, barTop, zone.width, barHeight, { color: MARGIN_FILL, borderColor: MARGIN_HATCH, borderWidth: mm(0.25), borderDashArray: [mm(1), mm(1)] });
            hatch(pen, zone.from, barTop, zone.width, barHeight);
          }
        }
        if (row.isMilestone) {
          const size = 1.9;
          const centreX = dayX(row.barStartDay + row.barDays / 2, window);
          const centreY = rowTop + CHART_ROW_H / 2;
          if (centreX - size >= chartLeft && centreX + size <= chartRight) {
            pen.line(centreX, centreY - size, centreX + size, centreY, { color: MILESTONE, thickness: mm(0.4) });
            pen.line(centreX + size, centreY, centreX, centreY + size, { color: MILESTONE, thickness: mm(0.4) });
            pen.line(centreX, centreY + size, centreX - size, centreY, { color: MILESTONE, thickness: mm(0.4) });
            pen.line(centreX - size, centreY, centreX, centreY - size, { color: MILESTONE, thickness: mm(0.4) });
            pen.rect(centreX - size * 0.62, centreY - size * 0.62, size * 1.24, size * 1.24, { color: MILESTONE, opacity: 0.45 });
          }
          return;
        }
        const barWidthMm = Math.max(row.barDays * dayWidthMm, 0.8);
        const bar = clip(dayX(row.barStartDay, window), barWidthMm);
        if (bar.width <= 0) return;
        if (row.isSummary) {
          // A summary is drawn the way the screen draws it: a bar with end caps.
          pen.rect(bar.from, barTop + 0.6, bar.width, 2.2, { color: SUMMARY_BAR });
          pen.rect(bar.from, barTop, 1.2, barHeight, { color: SUMMARY_BAR });
          pen.rect(bar.from + bar.width - 1.2, barTop, 1.2, barHeight, { color: SUMMARY_BAR });
          return;
        }
        pen.rect(bar.from, barTop, bar.width, barHeight, {
          color: row.isCritical ? CRITICAL : barColour(row.colorKey),
          borderColor: row.isCritical ? CRITICAL_EDGE : hex(PALETTE.barEdge),
          borderWidth: mm(0.2),
        });
        if (row.progressPct > 0) {
          const filled = clip(dayX(row.barStartDay, window), (barWidthMm * row.progressPct) / 100);
          if (filled.width > 0) {
            pen.rect(filled.from, barTop, filled.width, barHeight, row.isCritical
              ? { color: CRITICAL_EDGE, opacity: 0.85 }
              : { color: WHITE, opacity: 0.45 });
          }
        }
      });

      if (chart.todayOffsetDays >= window.startDay && chart.todayOffsetDays < window.startDay + window.dayCount) {
        const todayX = dayX(chart.todayOffsetDays, window);
        pen.line(todayX, top, todayX, rowsBottom, { color: TODAY, thickness: mm(0.35), dashArray: [mm(1.2), mm(1.2)] });
        pen.textAt("Today", todayX + 0.8, rowsBottom + 3.2, 6.5, bold, TODAY);
      }
    };

    // Rows are paginated first, so a task keeps the same vertical place on every
    // timeline window — and the name column is drawn on every chart page.
    rowBlocks.forEach((block, blockIndex) => {
      layout.windows.forEach((window, windowIndex) => drawChartPage(block, window, windowIndex, blockIndex));
    });
  }

  /* -------------------------------------------------------- header, footer */

  const total = pens.length;
  pens.forEach((pen, index) => {
    const client = model.meta.client ? `  ·  ${model.meta.client}` : "";
    pen.text(fit(`${model.meta.projectName}${client}`, usable, 12, bold), left, 7, 12, 12, bold, INK);
    const details = `Version: ${model.meta.versionName}  ·  Mode: ${model.meta.modeLabel}  ·  Baseline active: ${model.meta.baselineLine}  ·  Export date: ${model.meta.exportDateLabel}`;
    pen.text(fit(details, usable, 8), left, 15, 8, 8, font, MUTED);
    pen.line(left, 21, left + usable, 21, { color: RULE, thickness: mm(0.35) });
    pen.text(fit(model.fileName, usable * 0.7, 7.5), left, height - 9, 7.5, 7.5, font, MUTED);
    const pageLabel = `Page ${index + 1} of ${total}`;
    pen.textAt(pageLabel, left + usable - widthOf(pageLabel, 7.5), height - 6.5, 7.5, font, MUTED);
  });

  return await doc.save();
}

/* ------------------------------------------------------------- the file */

/**
 * One rendered export: the real bytes, the blob the browser downloads and the
 * object URL that points at them. The URL is what "Download PDF" reuses, so the
 * name and the file can never drift apart, and it is released as soon as the
 * message is gone — the temporary file never piles up in memory.
 */
export interface PlannerPdfFile {
  fileName: string;
  bytes: Uint8Array;
  blob: Blob;
  url: string;
}

/**
 * Renders the plan into a real PDF file. Nothing is announced to the user here:
 * the caller only reports success once this promise resolves, so "Export ready"
 * always means a file that exists. A failure rejects, with a message the page can
 * show as it is.
 */
export async function createPlannerPdfFile(model: PlannerPdfModel, options: PlannerPdfOptions = {}): Promise<PlannerPdfFile> {
  const bytes = await renderPlannerPdf(model, options);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  try {
    return { fileName: model.fileName, bytes, blob, url: URL.createObjectURL(blob) };
  } catch {
    // Without an object URL there is nothing to hand to the browser; the page
    // shows this instead of a false "Export ready".
    throw new Error("The PDF was created but this browser cannot hand it over for download.");
  }
}

/**
 * Hands an existing file to the browser with one direct anchor click — no
 * pop-up, and no delay between the user's click and the download. The object URL
 * stays valid until `releasePlannerPdfFile`, so the same file can be downloaded
 * again from the "Download PDF" button.
 */
export function startPdfDownload(file: PlannerPdfFile): void {
  const link = document.createElement("a");
  link.href = file.url;
  link.download = file.fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Releases the temporary file: the object URL is revoked and the blob freed. */
export function releasePlannerPdfFile(file: PlannerPdfFile): void {
  URL.revokeObjectURL(file.url);
}
