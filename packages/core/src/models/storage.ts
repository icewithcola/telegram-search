import type { CoreDB } from '../db'
import type { CoreMessageMedia } from '../types/media'
import type { StorageUsage } from '../types/storage'

import { sql } from 'drizzle-orm'

const CHAT_BATCH_SIZE = 50

interface MessageSizeRow extends Record<string, unknown> {
  id: string
  bytes: string
  media: CoreMessageMedia[]
}

interface PhotoSizeRow extends Record<string, unknown> {
  id: string
  bytes: string
  image_path: string
  image_thumbnail_path: string
}

interface StickerSizeRow extends Record<string, unknown> {
  id: string
  bytes: string
  sticker_path: string
}

export interface ChatStorageBatch {
  cursor?: string
  hasMore: boolean
  messageCount: number
  messageBytes: number
  photos: PhotoSizeRow[]
  stickers: StickerSizeRow[]
}

/** Physical application table and index sizes, shared across all accounts. */
export async function fetchStorageUsage(db: CoreDB): Promise<StorageUsage> {
  const result = await db.execute<{ total_bytes: string }>(sql`
    SELECT COALESCE(SUM(pg_total_relation_size(relid)), 0)::text AS total_bytes
    FROM pg_catalog.pg_statio_user_tables
    WHERE schemaname = 'public'
  `)
  return { totalBytes: Number(result.rows[0].total_bytes) }
}

/** Scan only a bounded page of visible messages and their persisted media records. */
export async function fetchChatStorageBatch(db: CoreDB, accountId: string, chatId: string, cursor?: string): Promise<ChatStorageBatch> {
  const result = await db.execute<MessageSizeRow>(sql`
    SELECT m.id, pg_column_size(m)::text AS bytes, m.media
    FROM chat_messages m
    WHERE m.platform = 'telegram' AND m.in_chat_id = ${chatId}
      AND (m.owner_account_id = ${accountId} OR m.owner_account_id IS NULL)
      AND ${cursor === undefined ? sql`TRUE` : sql`m.id > ${cursor}`}
      AND EXISTS (
        SELECT 1 FROM account_joined_chats a
        JOIN joined_chats c ON c.id = a.joined_chat_id
        WHERE a.account_id = ${accountId} AND c.chat_id = m.in_chat_id
          AND c.platform = m.platform
      )
    ORDER BY m.id
    LIMIT ${CHAT_BATCH_SIZE + 1}
  `)
  const messages = result.rows.slice(0, CHAT_BATCH_SIZE)
  if (messages.length === 0)
    return { hasMore: false, messageCount: 0, messageBytes: 0, photos: [], stickers: [] }

  const messageIds = messages.map(row => row.id)
  const photoIds = [...new Set(messages.flatMap(row => row.media ?? [])
    .filter(media => media.type === 'photo')
    .map(media => media.platformId))]
  const photoResult = await db.execute<PhotoSizeRow>(sql`
    SELECT p.id, (
      pg_column_size(p)
      + COALESCE(octet_length(p.image_bytes), 0)
      + COALESCE(octet_length(p.image_thumbnail_bytes), 0)
    )::text AS bytes, p.image_path, p.image_thumbnail_path
    FROM photos p
    WHERE p.platform = 'telegram'
      AND (
        p.message_id IN (${sql.join(messageIds.map(id => sql`${id}`), sql`, `)})
        ${photoIds.length === 0 ? sql`` : sql`OR p.file_id IN (${sql.join(photoIds.map(id => sql`${id}`), sql`, `)})`}
      )
  `)

  const stickerIds = [...new Set(messages.flatMap(row => row.media ?? [])
    .filter(media => media.type === 'sticker')
    .map(media => media.platformId))]
  const stickers = stickerIds.length === 0
    ? []
    : (await db.execute<StickerSizeRow>(sql`
        SELECT s.id, (
          pg_column_size(s) + COALESCE(octet_length(s.sticker_bytes), 0)
        )::text AS bytes, s.sticker_path
        FROM stickers s
        WHERE s.platform = 'telegram'
          AND s.file_id IN (${sql.join(stickerIds.map(id => sql`${id}`), sql`, `)})
      `)).rows

  return {
    cursor: messages.at(-1)!.id,
    hasMore: result.rows.length > CHAT_BATCH_SIZE,
    messageCount: messages.length,
    messageBytes: messages.reduce((sum, row) => sum + Number(row.bytes), 0),
    photos: photoResult.rows,
    stickers,
  }
}

/** Row-size estimates exclude shared indexes and free space. */
export async function fetchChatStorageUsage(db: CoreDB, accountId: string, chatId: string): Promise<StorageUsage> {
  const usage = { totalBytes: 0, messageBytes: 0, photoBytes: 0, stickerBytes: 0, mediaBytes: 0 } satisfies StorageUsage
  const seenPhotos = new Set<string>()
  const seenStickers = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const batch = await fetchChatStorageBatch(db, accountId, chatId, cursor)
    usage.messageBytes += batch.messageBytes
    for (const photo of batch.photos) {
      if (seenPhotos.has(photo.id))
        continue
      seenPhotos.add(photo.id)
      usage.photoBytes += Number(photo.bytes)
    }
    for (const sticker of batch.stickers) {
      if (seenStickers.has(sticker.id))
        continue
      seenStickers.add(sticker.id)
      usage.stickerBytes += Number(sticker.bytes)
    }
    usage.totalBytes = usage.messageBytes + usage.photoBytes + usage.stickerBytes
    if (!batch.hasMore)
      return usage
    cursor = batch.cursor
  }
}
