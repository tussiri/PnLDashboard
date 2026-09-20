export interface CsvColumn<T> {
  key: string
  header: string
  value?: (row: T) => unknown
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Builds RFC-4180 style CSV text. Numbers are written raw (no thousands separators) so spreadsheets parse them. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(',')
  const body = rows.map((row) => columns.map((c) => escapeCell(c.value ? c.value(row) : (row as Record<string, unknown>)[c.key])).join(','))
  return [header, ...body].join('\r\n')
}

export function downloadCsv(filename: string, csv: string) {
  if (typeof document === 'undefined') return
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
