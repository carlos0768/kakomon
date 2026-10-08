#!/usr/bin/env node
/**
 * 管理者用 CLI。予想問題を作る主体は管理者なので、作問系の操作はここ (または Mastra Studio) から行う。
 *
 *   npm run admin -- ingest  <pdf> [--title T] [--year Y] [--session S] [--id ID]
 *   npm run admin -- solve   <examId>                  正解が無い過去問に AI 推定の正解と根拠を付ける
 *   npm run admin -- analyze [--exam-ids a,b] [--title T] [--focus "..."] [--spec-id ID]
 *   npm run admin -- generate --spec <specId> --title "..." [--ref <examId>] [--count N] [--instructions "..."] [--max-revisions N]
 *   npm run admin -- approve <runId> [--reject] [--note "..."]
 *   npm run admin -- render  <examId> [--answers]        HTML/PDF を再生成
 *   npm run admin -- list    [exams|specs|users]
 *   npm run admin -- export-spec <specId> [--out path]   要件定義を Markdown で書き出す
 *   npm run admin -- user create <username> <password>   受験者アカウントを作る
 *   npm run admin -- user reset-password <username> <newPassword>   パスワードを再設定 (忘れたとき)
 */
import { writeFile } from 'node:fs/promises'
import { mastra } from '../mastra/index.ts'
import { anthropicOptions, config } from '../mastra/config.ts'
import { getExam, getSpec, listExams, listSpecs, saveExam } from '../mastra/db/repo.ts'
import { renderExamFiles } from '../mastra/render/pdf.ts'
import { adminApprovalStep } from '../mastra/workflows/generate-exam.workflow.ts'
import { specToMarkdown } from '../mastra/services/spec-markdown.ts'
import { listUsers, registerUser, resetPassword } from '../mastra/services/auth.ts'
import { streamObject } from '../mastra/services/llm.ts'
import { z } from 'zod'

const [, , command, ...rest] = process.argv

function parseArgs(args: string[]) {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(rest)
const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined)

function printResult(res: { status: string; [k: string]: unknown }) {
  if (res.status === 'success') {
    console.log(JSON.stringify(res.result, null, 2))
  } else if (res.status === 'suspended') {
    console.log(JSON.stringify({ status: 'suspended', suspended: res.suspended, steps: res.steps }, null, 2))
  } else {
    console.error(JSON.stringify(res, null, 2))
    process.exitCode = 1
  }
}

async function main() {
  switch (command) {
    case 'ingest': {
      const filePath = positional[0]
      if (!filePath) throw new Error('usage: ingest <pdf> [--title T] [--year Y] [--session S] [--id ID]')
      const run = await mastra.getWorkflow('ingestExamWorkflow').createRun()
      const res = await run.start({
        inputData: { filePath, kind: 'past', title: str('title'), year: num('year'), session: str('session'), examId: str('id') },
      })
      printResult(res)
      break
    }
    case 'solve': {
      const examId = positional[0]
      if (!examId) throw new Error('usage: solve <examId>')
      const rec = await getExam(examId)
      if (!rec) throw new Error(`exam not found: ${examId}`)
      const targets = rec.exam.questions.filter(q => !q.correctLabel || q.choices.some(c => !c.rationale))
      if (!targets.length) {
        console.log('すべての設問に正解と根拠が付いています')
        break
      }
      const schema = z.object({
        answers: z.array(
          z.object({
            number: z.number().int(),
            correctLabel: z.string(),
            confidence: z.number().min(0).max(1),
            rationales: z.array(z.object({ label: z.string(), rationale: z.string() })),
          }),
        ),
      })
      const agent = mastra.getAgentById('exam-reviewer')
      const raw = await streamObject(
        agent,
        `次の過去問設問について、正解の選択肢と、各選択肢が正解/不正解である根拠を示してください。確信が持てない場合は confidence を下げてください。\n\n${JSON.stringify({
          passages: rec.exam.passages,
          questions: targets.map(q => ({ number: q.number, passageId: q.passageId, passage: q.passage, stem: q.stem, choices: q.choices.map(c => ({ label: c.label, text: c.text })) })),
        })}`,
        { structuredOutput: { schema, jsonPromptInjection: 'auto' }, modelSettings: { maxOutputTokens: 32000 }, providerOptions: anthropicOptions('high') },
      )
      const parsed = schema.parse(raw)
      for (const a of parsed.answers) {
        const q = rec.exam.questions.find(q => q.number === a.number)
        if (!q) continue
        if (!q.correctLabel) {
          q.correctLabel = a.correctLabel
          q.explanation = `${q.explanation ? q.explanation + '\n' : ''}[AI推定 confidence=${a.confidence}]`
        }
        for (const r of a.rationales) {
          const c = q.choices.find(c => c.label === r.label)
          if (c && !c.rationale) c.rationale = r.rationale
        }
      }
      await saveExam({ id: rec.id, kind: rec.kind, exam: rec.exam, status: rec.status, sourceFile: rec.sourceFile, specId: rec.specId })
      console.log(JSON.stringify({ examId: rec.id, solved: parsed.answers.map(a => ({ number: a.number, correctLabel: a.correctLabel, confidence: a.confidence })) }, null, 2))
      break
    }
    case 'analyze': {
      const run = await mastra.getWorkflow('analyzeExamWorkflow').createRun()
      const res = await run.start({
        inputData: { examIds: str('exam-ids')?.split(',').filter(Boolean), title: str('title'), focus: str('focus'), specId: str('spec-id') },
      })
      printResult(res)
      if (res.status === 'success') {
        const spec = await getSpec(res.result.specId)
        if (spec) {
          const out = `${config.projectRoot}/docs/specs/${spec.id}.md`
          await writeFile(out, specToMarkdown(spec.spec, spec.id), 'utf8').catch(() => undefined)
          console.log(`要件定義 (Markdown): ${out}`)
        }
      }
      break
    }
    case 'generate': {
      const specId = str('spec')
      const title = str('title')
      if (!specId || !title) throw new Error('usage: generate --spec <specId> --title "..." [--ref examId] [--count N]')
      const workflow = mastra.getWorkflow('generateExamWorkflow')
      const run = await workflow.createRun()
      console.error(`runId: ${run.runId}`)
      const res = await run.start({
        inputData: {
          specId,
          title,
          referenceExamId: str('ref'),
          questionCount: num('count'),
          instructions: str('instructions'),
          maxRevisions: num('max-revisions') ?? 1,
        },
      })
      printResult(res)
      if (res.status === 'suspended') {
        console.error(`\n下書きを確認後、次のコマンドで承認/却下してください:\n  npm run admin -- approve ${run.runId}\n  npm run admin -- approve ${run.runId} --reject`)
      }
      break
    }
    case 'approve': {
      const runId = positional[0]
      if (!runId) throw new Error('usage: approve <runId> [--reject] [--note "..."]')
      const run = await mastra.getWorkflow('generateExamWorkflow').createRun({ runId })
      const res = await run.resume({ step: adminApprovalStep, resumeData: { approved: !flags.reject, note: str('note') } })
      printResult(res)
      break
    }
    case 'render': {
      const examId = positional[0]
      if (!examId) throw new Error('usage: render <examId> [--answers]')
      const rec = await getExam(examId)
      if (!rec) throw new Error(`exam not found: ${examId}`)
      console.log(JSON.stringify(await renderExamFiles(rec.id, rec.exam, { withAnswers: Boolean(flags.answers) }), null, 2))
      break
    }
    case 'list': {
      const what = positional[0] ?? 'exams'
      if (what === 'specs') {
        for (const s of await listSpecs()) console.log(`${s.id}\t${s.status}\t${s.title}\t(${s.spec.sourceExamIds.length} exams)`)
      } else if (what === 'users') {
        for (const u of await listUsers()) console.log(`${u.id}\t${u.username}\t${u.createdAt}`)
      } else {
        for (const e of await listExams()) console.log(`${e.id}\t${e.kind}\t${e.status}\t${e.year ?? '-'}\t${e.title}\t${e.exam.questions.length}問`)
      }
      break
    }
    case 'export-spec': {
      const specId = positional[0]
      if (!specId) throw new Error('usage: export-spec <specId> [--out path]')
      const spec = await getSpec(specId)
      if (!spec) throw new Error(`spec not found: ${specId}`)
      const md = specToMarkdown(spec.spec, spec.id)
      const out = str('out')
      if (out) {
        await writeFile(out, md, 'utf8')
        console.log(`written: ${out}`)
      } else console.log(md)
      break
    }
    case 'user': {
      const [sub, username, password] = positional
      if (sub === 'create' && username && password) {
        const u = await registerUser(username, password)
        console.log(`created: ${u.username} (${u.id})`)
      } else if (sub === 'reset-password' && username && password) {
        await resetPassword(username, password)
        console.log(`password reset: ${username} (既存のログインは無効化されました)`)
      } else {
        throw new Error('usage: user create <username> <password> | user reset-password <username> <newPassword>')
      }
      break
    }
    default:
      console.error(`unknown command: ${command ?? '(none)'}\n\n${usage()}`)
      process.exitCode = 1
  }
}

function usage() {
  return `commands: ingest | solve | analyze | generate | approve | render | list | export-spec | user`
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})
