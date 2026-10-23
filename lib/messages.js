/** messages.js —— 插件消息构造（v1.3.1 从 index.js 抽出）
 * 权威形状取自官方 dsh-repeat-tool-reminder：{role:"user", id, source:{kind,form,summary}, content}。
 * source.kind 用插件名，绝不写 "user"（"user" 是真人消息标记）。 */
import { randomUUID } from 'node:crypto'

export const msg = (text, summary) => ({
    role: 'user',
    id: randomUUID(),
    source: {
      kind: 'plugin:dsh-fast-react',
      form: 'notice',
      summary: String(summary || text).replace(/\s+/g, ' ').slice(0, 90),
    },
    content: [{ type: 'text', text }],
  })
