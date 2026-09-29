import type { CoreDB } from '../../db'
import type { Models } from '../../models'
import type { StorageEventFromCore } from '../../types/events'
import type { MediaBinaryProvider } from '../../types/storage'

import { PGlite } from '@electric-sql/pglite'
import { useLogger } from '@guiiai/logg'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCoreContext } from '../../context'
import { registerStorageEventHandlers } from '../../event-handlers/storage'
import { CoreEventType } from '../../types/events'
import { fetchChatStorageUsage, fetchStorageUsage } from '../storage'

// Minimal real PostgreSQL tables exercise sizing functions and account isolation.
const client = new PGlite()
const db = drizzle(client) as unknown as CoreDB

beforeAll(async () => {
  await client.exec(`
    CREATE TABLE joined_chats (id text PRIMARY KEY, chat_id text, platform text);
    CREATE TABLE account_joined_chats (account_id text, joined_chat_id text);
    CREATE TABLE chat_messages (
      id text PRIMARY KEY, platform text, in_chat_id text,
      owner_account_id text, content text, media jsonb DEFAULT '[]'::jsonb
    );
    CREATE TABLE photos (id text PRIMARY KEY, platform text, file_id text, message_id text, caption text, image_bytes bytea, image_thumbnail_bytes bytea, image_path text DEFAULT '', image_thumbnail_path text DEFAULT '');
    CREATE TABLE stickers (id text PRIMARY KEY, platform text, file_id text, sticker_bytes bytea, sticker_path text);
    INSERT INTO joined_chats VALUES ('joined', 'chat', 'telegram');
    INSERT INTO account_joined_chats VALUES ('alice', 'joined'), ('bob', 'joined');
    INSERT INTO chat_messages (id, platform, in_chat_id, owner_account_id, content) VALUES
      ('alice-message', 'telegram', 'chat', 'alice', 'private'),
      ('shared-message', 'telegram', 'chat', NULL, 'shared');
    UPDATE chat_messages SET media = '[{"type":"sticker","platformId":"sticker-1"}]'::jsonb;
    UPDATE chat_messages SET media = '[{"type":"sticker","platformId":"sticker-1"},{"type":"photo","platformId":"photo-1"}]'::jsonb WHERE id = 'alice-message';
    INSERT INTO photos (id, platform, file_id, message_id, caption, image_bytes, image_thumbnail_bytes, image_path) VALUES
      ('photo', 'telegram', 'photo-1', 'other-message', 'private photo', '\x010203'::bytea, '\x0405'::bytea, 'photo/external');
    INSERT INTO stickers VALUES ('sticker', 'telegram', 'sticker-1', NULL, 'sticker/external');
  `)
})

afterAll(async () => {
  await client.close()
})

describe('storage usage', () => {
  it('reports physical database table and index bytes', async () => {
    const usage = await fetchStorageUsage(db)
    expect(usage.totalBytes).toBeGreaterThan(0)
    expect(Number.isFinite(usage.totalBytes)).toBe(true)
  })

  it('counts visible messages and their media, including a photo record linked to another message', async () => {
    const alice = await fetchChatStorageUsage(db, 'alice', 'chat')
    const bob = await fetchChatStorageUsage(db, 'bob', 'chat')
    expect(alice.messageBytes).toBeGreaterThan(bob.messageBytes!)
    expect(bob.messageBytes).toBeGreaterThan(0)
    expect(alice.photoBytes).toBeGreaterThan(0)
    expect(bob.photoBytes).toBe(0)
    expect(alice.stickerBytes).toBe(bob.stickerBytes)
    expect(alice.stickerBytes).toBeGreaterThan(0)
    expect(alice.totalBytes).toBe(alice.messageBytes! + alice.photoBytes! + alice.stickerBytes!)
  })

  it('returns zero for an inaccessible or empty chat', async () => {
    const empty = { totalBytes: 0, messageBytes: 0, photoBytes: 0, stickerBytes: 0, mediaBytes: 0 }
    expect(await fetchChatStorageUsage(db, 'outsider', 'chat')).toEqual(empty)
    expect(await fetchChatStorageUsage(db, 'alice', 'missing')).toEqual(empty)
  })

  it('streams the complete chat size including external media without loading file contents', async () => {
    // External photo and sticker paths previously contributed zero bytes to chat usage.
    const size = vi.fn(async (location: { path: string }) => location.path === 'photo/external' ? 11 : 7)
    const provider: MediaBinaryProvider = {
      save: vi.fn(async () => { throw new Error('not used') }),
      load: vi.fn(async () => { throw new Error('media contents must not be loaded') }),
      size,
    }
    const ctx = createCoreContext(() => db, {} as Models, useLogger())
    ctx.setCurrentAccountId('alice')
    registerStorageEventHandlers(ctx, useLogger(), {} as Models, provider)

    const result = new Promise<Parameters<StorageEventFromCore[CoreEventType.StorageUsage]>[0]>((resolve) => {
      ctx.emitter.on(CoreEventType.StorageUsage, data => resolve(data))
    })
    ctx.emitter.emit(CoreEventType.StorageFetchUsage, { requestId: 'test-usage', chatId: 'chat' })
    const response = await result
    expect(response.done).toBe(true)
    expect(response.usage?.mediaBytes).toBe(18)
    expect(response.usage?.stickerBytes).toBeGreaterThan(0)
    expect(response.usage?.totalBytes).toBe(
      response.usage!.messageBytes! + response.usage!.photoBytes! + response.usage!.stickerBytes! + 18,
    )
    expect(size).toHaveBeenCalledTimes(2)
    expect(provider.load).not.toHaveBeenCalled()
    ctx.cleanup()
  })

  it('emits cumulative progress for successive message batches', async () => {
    await client.exec(`
      INSERT INTO joined_chats VALUES ('joined-large', 'large', 'telegram');
      INSERT INTO account_joined_chats VALUES ('alice', 'joined-large');
      INSERT INTO chat_messages (id, platform, in_chat_id, owner_account_id, content)
      SELECT 'large-' || g, 'telegram', 'large', 'alice', 'message'
      FROM generate_series(1, 51) AS g;
    `)
    const ctx = createCoreContext(() => db, {} as Models, useLogger())
    ctx.setCurrentAccountId('alice')
    registerStorageEventHandlers(ctx, useLogger(), {} as Models, undefined)

    const progress: Array<{ done: boolean, scannedMessages?: number, totalBytes: number }> = []
    const finished = new Promise<void>((resolve) => {
      ctx.emitter.on(CoreEventType.StorageUsage, (data) => {
        if (data.requestId !== 'large-usage' || !data.usage)
          return
        progress.push({ done: data.done, scannedMessages: data.usage.scannedMessages, totalBytes: data.usage.totalBytes })
        if (data.done)
          resolve()
      })
    })
    ctx.emitter.emit(CoreEventType.StorageFetchUsage, { requestId: 'large-usage', chatId: 'large' })
    await finished
    expect(progress).toHaveLength(2)
    expect(progress.map(item => item.scannedMessages)).toEqual([50, 51])
    expect(progress.map(item => item.done)).toEqual([false, true])
    expect(progress[1].totalBytes).toBeGreaterThan(progress[0].totalBytes)
    ctx.cleanup()
  })
})
