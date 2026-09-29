import type { CoreDB } from '../db'
import type { StorageUsage } from '../types/storage'

import { sql } from 'drizzle-orm'

/** Physical application table and index sizes, shared across all accounts. */
export async function fetchStorageUsage(db: CoreDB): Promise<StorageUsage> {
  const result = await db.execute<{ total_bytes: string }>(sql`
    SELECT COALESCE(SUM(pg_total_relation_size(relid)), 0)::text AS total_bytes
    FROM pg_catalog.pg_statio_user_tables
    WHERE schemaname = 'public'
  `)
  return { totalBytes: Number(result.rows[0].total_bytes) }
}

/** Row-size estimates exclude shared indexes and free space. */
export async function fetchChatStorageUsage(db: CoreDB, accountId: string, chatId: string): Promise<StorageUsage> {
  const result = await db.execute<{ message_bytes: string, photo_bytes: string }>(sql`
    WITH visible_messages AS MATERIALIZED (
      SELECT m.id, pg_column_size(m) AS bytes
      FROM chat_messages m
      WHERE m.platform = 'telegram' AND m.in_chat_id = ${chatId}
        AND (m.owner_account_id = ${accountId} OR m.owner_account_id IS NULL)
        AND EXISTS (
          SELECT 1 FROM account_joined_chats a
          JOIN joined_chats c ON c.id = a.joined_chat_id
          WHERE a.account_id = ${accountId} AND c.chat_id = m.in_chat_id
            AND c.platform = m.platform
        )
    )
    SELECT
      (SELECT COALESCE(SUM(bytes), 0)::text FROM visible_messages) AS message_bytes,
      (SELECT COALESCE(SUM(
         pg_column_size(p)
         + COALESCE(octet_length(p.image_bytes), 0)
         + COALESCE(octet_length(p.image_thumbnail_bytes), 0)
       ), 0)::text FROM photos p
       WHERE p.message_id IN (SELECT id FROM visible_messages)) AS photo_bytes
  `)
  const messageBytes = Number(result.rows[0].message_bytes)
  const photoBytes = Number(result.rows[0].photo_bytes)
  return { totalBytes: messageBytes + photoBytes, messageBytes, photoBytes }
}
