#!/usr/bin/env node
/**
 * Scripted Telegram Bot API server for host E2E testing.
 *
 * - Serves the Bot API surface the plugin uses (getUpdates, sendMessage,
 *   sendRichMessage, sendChatAction, answerCallbackQuery,
 *   editMessageReplyMarkup, setMyCommands, getMe).
 * - Control endpoints:
 *     POST /_control/update   { update_id, message | callback_query, ... }
 *                             → queue one update for the next getUpdates
 *     GET  /_control/calls    → all recorded calls as JSON
 *     POST /_control/reset    → clear the recorded calls
 * - Every call is appended to the JSONL file given via --log.
 *
 * Usage: node scripts/mock-telegram.mjs --port 8000 --log /tmp/tg.jsonl
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const port = Number(flag('--port', '8000'))
const logFile = flag('--log', '')

const queue = []
const calls = []
let messageId = 0

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const url = req.url ?? ''
    if (url.startsWith('/_control/')) {
      if (url === '/_control/update') {
        queue.push(JSON.parse(body || '{}'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, queued: queue.length }))
        return
      }
      if (url === '/_control/calls') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(calls))
        return
      }
      if (url === '/_control/reset') {
        calls.length = 0
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404)
      res.end('not found')
      return
    }
    const method = url.slice(url.lastIndexOf('/') + 1)
    const parsed = body ? JSON.parse(body) : {}
    const record = { method, body: parsed, at: new Date().toISOString() }
    calls.push(record)
    if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`)
    let result
    if (method === 'getUpdates') {
      result = queue.splice(0, 1)
    } else if (method === 'sendMessage' || method === 'sendRichMessage') {
      messageId += 1
      const rich = parsed.rich_message
      result = {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: parsed.chat_id, type: 'private' },
        text: String(parsed.text ?? rich?.markdown ?? ''),
      }
    } else if (method === 'getMe') {
      result = { id: 1, is_bot: true, first_name: 'mock' }
    } else {
      result = true
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-telegram listening on http://127.0.0.1:${port}`)
})
