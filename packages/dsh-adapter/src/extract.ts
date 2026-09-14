import type { ContentBlock, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CompactionEntry, MemoryInput, MemoryRole } from '@dsh-memory/core'

export const PLUGIN_ID = 'dsh-selective-memory'

function sourcePlugin(message: Message): string | undefined {
  const source = message.source
  return source.kind === 'plugin' ? source.plugin : undefined
}

export function contentToText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractQuery(messages: readonly UserMessage[]): string {
  const preferred = messages
    .filter(message => message.source.kind === 'user')
    .map(message => contentToText(message.content))
    .filter(Boolean)
  const fallback = messages
    .filter(message => sourcePlugin(message) !== PLUGIN_ID)
    .map(message => contentToText(message.content))
    .filter(Boolean)
  return (preferred.length > 0 ? preferred : fallback).join('\n')
}

function truncateEvent(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  const head = Math.ceil((maxChars - 1) * 0.75)
  const tail = Math.max(0, maxChars - head - 1)
  return { text: `${value.slice(0, head)}…${value.slice(-tail)}`, truncated: true }
}

function importance(role: MemoryRole, content: string): number {
  const base = role === 'user' ? 0.68 : role === 'assistant' ? 0.48 : 0.35
  const explicit = /\b(remember|must|requirement|decision|decided|error|fix|path|deadline|constraint)\b|记住|必须|要求|决定|错误|修复|路径|截止|约束/iu.test(content)
  return Math.min(1, base + (explicit ? 0.2 : 0))
}

function messageInput(
  sessionId: string,
  event: SessionEvent,
  message: Message,
  role: MemoryRole,
  maxChars: number,
): MemoryInput | undefined {
  const plugin = sourcePlugin(message)
  if (plugin === PLUGIN_ID || plugin === 'compact') return
  const extracted = truncateEvent(contentToText(message.content), maxChars)
  if (extracted.text.length === 0) return
  return {
    sessionId,
    sourceEventSeq: Number(event.seq),
    role,
    sourceType: event.type,
    content: extracted.text,
    timestamp: event.time,
    importance: importance(role, extracted.text),
    metadata: {
      sourceKind: message.source.kind,
      truncated: extracted.truncated,
    },
  }
}

export function sessionEventToMemoryInput(
  sessionId: string,
  event: SessionEvent,
  maxChars: number,
): MemoryInput | undefined {
  switch (event.type) {
    case 'user/message':
      return messageInput(sessionId, event, event.data, 'user', maxChars)
    case 'assistant/message':
      return messageInput(sessionId, event, event.data.message, 'assistant', maxChars)
    case 'tool/result':
      return messageInput(sessionId, event, event.data.message, 'tool', maxChars)
    default:
      return undefined
  }
}

export function messageToCompactionEntry(
  message: Message,
  timestamp: number,
): CompactionEntry | undefined {
  if (message.role === 'system') return
  const content = contentToText(message.content)
  if (content.length === 0 || sourcePlugin(message) === PLUGIN_ID) return
  const role: MemoryRole = message.source.kind === 'tool'
    ? 'tool'
    : message.role === 'assistant' ? 'assistant' : 'user'
  return {
    role,
    content,
    timestamp,
    importance: importance(role, content),
  }
}
