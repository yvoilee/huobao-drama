/**
 * 一次性恢复「因重启被标失败」的生成任务（CLI）
 *
 * 用法：cd backend && npx tsx scripts/recover-interrupted-tasks.ts [--hours 24]
 *
 * - 只挑选 status='failed' 且 error_msg 含「重启」且仍有 task_id 的视频任务
 * - 默认只恢复最近 24 小时内创建的任务（更早的任务上游几乎必被清理，
 *   恢复只会空轮询 50 分钟，故自动跳过）
 * - 复用 generation.resumeTasks → pollTask：仍在生成则继续轮询，
 *   已完成则立即下载回写；provider 已变更/缺失则标失败
 */
import 'dotenv/config'
import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import { resumeTasks } from '../src/services/generation.js'

function parseHoursArg(): number {
  const i = process.argv.indexOf('--hours')
  const raw = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(raw) && raw > 0 ? raw : 24
}

async function main() {
  const hours = parseHoursArg()
  const cutoff = Date.now() - hours * 60 * 60 * 1000

  const rows = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'failed'))

  const candidates = rows.filter((r) => {
    if (r.type !== 'video') return false
    if (!r.taskId) return false
    if (!(r.errorMsg || '').includes('重启')) return false
    const ts = Date.parse(r.createdAt)
    return Number.isFinite(ts) && ts >= cutoff
  })

  console.log(`窗口：最近 ${hours} 小时；命中 ${candidates.length} 个可尝试恢复的任务：`)
  for (const r of candidates) {
    console.log(`  #${r.id} ${r.model} task_id=${r.taskId} created=${r.createdAt}`)
  }

  if (!candidates.length) {
    console.log('无需恢复。')
    return
  }

  const { resumed, skipped } = await resumeTasks(candidates.map((r) => r.id))
  console.log(`已恢复轮询 ${resumed} 个，跳过 ${skipped} 个。`)
  console.log('恢复已启动：任务仍在生成则继续轮询（每 10s），已完成则立即下载回写；全部结束后进程退出。')
}

main().catch((err) => {
  console.error('恢复失败:', err)
  process.exit(1)
})
