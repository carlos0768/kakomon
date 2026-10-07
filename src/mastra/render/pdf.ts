import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import type { ExtractedExam } from '../schemas/exam.ts'
import { renderExamHtml, type RenderOptions } from './html.ts'

export interface RenderedFiles {
  htmlPath: string
  pdfPath?: string
  /** PDF 化をスキップした理由 (playwright 未導入など) */
  pdfSkippedReason?: string
}

/**
 * HTML を書き出し、playwright-core と Chromium が使える環境なら PDF も生成する。
 * playwright は optionalDependency なので、無い環境では HTML だけを出力する。
 */
export async function renderExamFiles(examId: string, exam: ExtractedExam, opts: RenderOptions = {}): Promise<RenderedFiles> {
  await mkdir(config.outDir, { recursive: true })
  const suffix = opts.withAnswers ? '-answers' : ''
  const htmlPath = path.join(config.outDir, `${examId}${suffix}.html`)
  const html = renderExamHtml(exam, opts)
  await writeFile(htmlPath, html, 'utf8')

  const pdfPath = path.join(config.outDir, `${examId}${suffix}.pdf`)
  try {
    const { chromium } = await import('playwright-core')
    const executablePath = process.env.KAKOMON_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
    const browser = await chromium.launch({ executablePath })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true })
    } finally {
      await browser.close()
    }
    return { htmlPath, pdfPath }
  } catch (err) {
    return { htmlPath, pdfSkippedReason: err instanceof Error ? err.message : String(err) }
  }
}
