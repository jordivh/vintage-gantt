import type { ExportSheet } from "./capacity-export";

/**
 * Writes the export sheets to a real `.xlsx` workbook and downloads it.
 *
 * The writer is imported on demand, so the spreadsheet code is only fetched when
 * someone actually exports. This is the only part of the export that touches the
 * browser: everything the file contains is built in `capacity-export.ts`.
 */
export async function downloadCapacityWorkbook(fileName: string, sheets: ExportSheet[]): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const workbook = writeXlsxFile(
    sheets.map((sheet) => ({
      sheet: sheet.name,
      data: sheet.data,
      columns: sheet.columns,
      stickyRowsCount: sheet.stickyRowsCount,
    })),
    { fontFamily: "Calibri", fontSize: 11 },
  );
  await workbook.toFile(fileName);
}
