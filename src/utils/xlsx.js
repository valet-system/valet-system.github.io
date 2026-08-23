/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FILE: src/utils/xlsx.js                                             │
 * │                                                                     │
 * │ WHAT THIS FILE IS                                                   │
 * │   downloadXlsx(filename, columns, rows) — a real formatted           │
 * │   spreadsheet: bold header, set column widths, a frozen top row.     │
 * │                                                                     │
 * │ ── WHY THE LIBRARY IS IMPORTED INSIDE THE FUNCTION ──────────────────│
 * │   `await import(...)` at the point of use, NOT a top-level import.    │
 * │                                                                     │
 * │   This project has four runtime dependencies and its stated premise  │
 * │   is loading fast on a cheap Android over hotel wifi. A spreadsheet  │
 * │   writer is the largest thing in it by some distance, and it is used  │
 * │   by one button on one screen that only a system admin ever opens.    │
 * │                                                                     │
 * │   Imported at the top of this file it would be bundled into whatever │
 * │   imports it, and every operator would download it to check a car in │
 * │   — paying for a feature they cannot reach. Imported here it becomes  │
 * │   its own chunk, fetched the first time somebody actually exports.    │
 * │                                                                     │
 * │ ── WHY xlsx AND NOT CSV ─────────────────────────────────────────────│
 * │   CSV is plain text and cannot carry a column width. That is not a    │
 * │   cosmetic loss: Excel renders a too-narrow date column as ########,  │
 * │   which reads as missing data rather than as a narrow column, and     │
 * │   that is exactly how it was read. A width fixes the cause.           │
 * │                                                                     │
 * │   It also removes the ="…" wrappers CSV needed to stop Excel eating   │
 * │   leading zeros and turning phone numbers into 9.87e+09. Here a cell  │
 * │   is declared a string and stays one, so the file is clean if anyone  │
 * │   opens it in anything else.                                          │
 * │                                                                     │
 * │ USED BY                                                             │
 * │   pages/system/Records. admin/Reviews still exports CSV — its file    │
 * │   is two columns wide and never hit the width problem.                │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { downloadBlob } from '@/utils/format'

/**
 * Header cells: bold, on a tinted band, frozen so it survives scrolling.
 *
 * `textColor`, not `color` — the library renamed it in 3.x and silently ignores
 * the old name, so a header written with `color` comes out with black text on
 * the band and looks like the style was never applied.
 */
const HEADER = {
  fontWeight: 'bold',
  backgroundColor: '#F4EFE6',
  textColor: '#14120E',
  align: 'left',
  // bottomBorderColor, not borderColor: a bare `borderColor` is expanded to
  // all four sides (getBorderXml defaults a coloured side with no style to
  // 'thin'), which draws vertical rules between header cells that line up with
  // nothing in the data below. One rule under the band is what is wanted.
  bottomBorderColor: '#D4C9B6',
  bottomBorderStyle: 'thin',
}

/**
 * @param filename   e.g. 'valet-guests-2026-08-23.xlsx'
 * @param rowColumns [{ key, label, width, align }] — our own shape, mapped to
 *                   the library's `columns` below
 * @param rows       plain objects keyed by `key`
 */
export async function downloadXlsx(filename, rowColumns, rows) {
  if (!rows?.length) return

  // See the header: this is the whole reason the export is not slower for
  // everyone who never uses it.
  // '/browser', not the bare package name. write-excel-file ships no "." export
  // — only ./node, ./browser and ./universal — so the bare import fails the
  // build outright with 'Missing "." specifier'. ./browser is the one that
  // hands the file to the user; ./node writes to a filesystem we do not have.
  const { default: writeXlsxFile } = await import('write-excel-file/browser')

  // ── THE v4 SHAPE, WHICH IS NOT THE v3 SHAPE ──────────────────────────
  // This was first written against the older `schema` option, and none of it
  // is caught by a build:
  //
  //   `schema` was removed outright  -> throws at runtime, on the click
  //   `column:` became `header:`     -> unnamed columns
  //   `value: (row) => ...` moved into a nested `cell(row)` returning
  //   the cell object, and `value` there is a plain value, not a getter
  //
  // If this ever throws '`schema` parameter was removed', that is a downgrade
  // to a v3-shaped call, not a broken export.
  const columns = rowColumns.map((col) => ({
    // The header follows its column's alignment. A right-aligned Token column
    // under a left-aligned "Token" header reads as a mistake.
    header: { ...HEADER, value: col.label, align: col.align ?? 'left' },
    // Every cell a STRING, deliberately. A token or a phone number is an
    // identifier that happens to be digits — read as a number it loses leading
    // zeros and renders in scientific notation past 11 digits. Nothing in this
    // file is ever summed.
    cell: (row) => {
      const v = row[col.key]
      return {
        value: v === null || v === undefined || v === '' ? null : String(v),
        type: String,
        align: col.align ?? 'left',
      }
    },
    width: col.width,
  }))

  // ── .toBlob(), NOT .toFile() ─────────────────────────────────────────
  // writeXlsxFile() does not download anything. It returns
  // { toBlob(), toFile(fileName) } and one of them has to be called — and it
  // takes no `fileName` option, so passing one builds the whole spreadsheet
  // and then discards it. No error, no file, nothing in the console.
  //
  // Its own .toFile() does download, but with this inside it:
  //
  //     setTimeout(() => URL.revokeObjectURL(url), 100)
  //
  // which is the race already measured and removed from downloadCsv — the
  // browser writes the file asynchronously and takes longer than that, so
  // revoking cancels a download that had begun. 100ms is the same bug on a
  // shorter fuse. So we take the blob and use our own downloader, which
  // releases the URL on pagehide instead of on a guess.
  const blob = await writeXlsxFile(rows, {
    columns,
    // The header row stays visible while scrolling a thousand rows, which is
    // the point at which a spreadsheet stops being readable without it.
    stickyRowsCount: 1,
  }).toBlob()

  downloadBlob(filename, blob)
}
