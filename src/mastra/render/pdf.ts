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
 * サーバレス用 Chromium の配布物。@sparticuz/chromium-min と同じバージョンにそろえる
 * (playwright-core が想定する Chromium のメジャーバージョンとも合わせる)
 */
const CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar'

/** PDF を生成できない環境 (Chromium が無いなど)。理由をそのまま利用者に見せてよい */
export class PdfUnavailableError extends Error {}

/**
 * Chromium を起動する。
 * - サーバレス (Vercel): @sparticuz/chromium-min で Lambda 互換の Chromium を取得して使う。
 *   本体 (約 70MB) を関数に同梱すると Vercel の上限 250MB を超えるので、初回起動時に CHROMIUM_PACK_URL から
 *   /tmp に展開する (同じインスタンスの 2 回目以降は再利用)
 * - それ以外: KAKOMON_CHROMIUM_PATH / PLAYWRIGHT_CHROMIUM_PATH、無ければ `npx playwright install chromium` で入れたもの
 * どちらも optionalDependency なので、無い環境では PdfUnavailableError を投げる。
 */
async function launchChromium() {
  let chromium: typeof import('playwright-core').chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch {
    throw new PdfUnavailableError('playwright-core が入っていないため PDF を生成できません')
  }
  if (config.isServerless) {
    let serverless: typeof import('@sparticuz/chromium-min').default
    try {
      serverless = (await import('@sparticuz/chromium-min')).default
    } catch {
      throw new PdfUnavailableError('@sparticuz/chromium-min が入っていないため PDF を生成できません')
    }
    const packUrl = process.env.KAKOMON_CHROMIUM_PACK_URL || CHROMIUM_PACK_URL
    return chromium.launch({ executablePath: await serverless.executablePath(packUrl), args: serverless.args })
  }
  const executablePath = process.env.KAKOMON_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
  try {
    return await chromium.launch({ executablePath })
  } catch (err) {
    throw new PdfUnavailableError(
      `Chromium を起動できません (npx playwright install chromium を実行してください): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** 試験を PDF にする。用紙サイズは HTML の @page (レイアウトプロファイル) に従う */
export async function renderExamPdf(exam: ExtractedExam, opts: RenderOptions = {}): Promise<Buffer> {
  const html = renderExamHtml(exam, { ...opts, webFonts: true })
  const browser = await launchChromium()
  try {
    const page = await browser.newPage()
    // 和文 Web フォントの読み込みを待つ。フォント配信に届かなくても、端末のフォントで PDF は出す
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined)
    await page.evaluate(() => document.fonts.ready).catch(() => undefined)
    return await page.pdf({ preferCSSPageSize: true, printBackground: true })
  } finally {
    await browser.close()
  }
}

/** PDF のファイル名 (Content-Disposition 用)。正解つきは -answers を付ける */
export function examPdfFileName(examId: string, opts: RenderOptions = {}): string {
  return `${examId}${opts.withAnswers ? '-answers' : ''}.pdf`
}

/**
 * HTML を書き出し、Chromium が使える環境なら PDF も生成する。
 * 使えない環境では HTML だけを出力し、理由を pdfSkippedReason に入れる。
 */
export async function renderExamFiles(examId: string, exam: ExtractedExam, opts: RenderOptions = {}): Promise<RenderedFiles> {
  await mkdir(config.outDir, { recursive: true })
  const suffix = opts.withAnswers ? '-answers' : ''
  const htmlPath = path.join(config.outDir, `${examId}${suffix}.html`)
  await writeFile(htmlPath, renderExamHtml(exam, opts), 'utf8')

  const pdfPath = path.join(config.outDir, examPdfFileName(examId, opts))
  try {
    await writeFile(pdfPath, await renderExamPdf(exam, opts))
    return { htmlPath, pdfPath }
  } catch (err) {
    return { htmlPath, pdfSkippedReason: err instanceof Error ? err.message : String(err) }
  }
}
