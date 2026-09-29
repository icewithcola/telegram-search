import type { CoreDB } from '../../db'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
      owner_account_id text, content text
    );
    CREATE TABLE photos (id text PRIMARY KEY, message_id text, caption text);
    INSERT INTO joined_chats VALUES ('joined', 'chat', 'telegram');
    INSERT INTO account_joined_chats VALUES ('alice', 'joined'), ('bob', 'joined');
    INSERT INTO chat_messages VALUES
      ('alice-message', 'telegram', 'chat', 'alice', 'private'),
      ('shared-message', 'telegram', 'chat', NULL, 'shared');
    INSERT INTO photos VALUES ('photo', 'alice-message', 'private photo');
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

  it('counts owned and shared messages, and only photos linked to visible messages', async () => {
    const alice = await fetchChatStorageUsage(db, 'alice', 'chat')
    const bob = await fetchChatStorageUsage(db, 'bob', 'chat')
    expect(alice.messageBytes).toBeGreaterThan(bob.messageBytes!)
    expect(bob.messageBytes).toBeGreaterThan(0)
    expect(alice.photoBytes).toBeGreaterThan(0)
    expect(bob.photoBytes).toBe(0)
    expect(alice.totalBytes).toBe(alice.messageBytes! + alice.photoBytes!)
  })

  it('returns zero for an inaccessible or empty chat', async () => {
    const empty = { totalBytes: 0, messageBytes: 0, photoBytes: 0 }
    expect(await fetchChatStorageUsage(db, 'outsider', 'chat')).toEqual(empty)
    expect(await fetchChatStorageUsage(db, 'alice', 'missing')).toEqual(empty)
  })
})
