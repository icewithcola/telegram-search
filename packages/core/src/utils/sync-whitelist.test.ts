import type { CoreContext } from '../context'

import { describe, expect, it } from 'vitest'

import { generateDefaultAccountSettings, normalizeAccountSettings } from './account-settings'
import { isChatWhitelisted, withSyncWhitelistLock } from './sync-whitelist'

describe('sync whitelist', () => {
  it('defaults to unrestricted sync and no cleanup', () => {
    const settings = generateDefaultAccountSettings()
    expect(settings.syncWhitelist).toEqual({ enabled: false, cleanExcluded: false, chatIds: [], chatTypes: [] })
    expect(isChatWhitelisted(settings.syncWhitelist, '42')).toBe(true)
  })

  it('combines categories and explicit chats and rejects unknown chats', () => {
    const settings = generateDefaultAccountSettings()
    settings.syncWhitelist = { enabled: true, cleanExcluded: true, chatIds: ['42'], chatTypes: ['user'] }
    const whitelist = normalizeAccountSettings(settings).syncWhitelist
    expect(isChatWhitelisted(whitelist, '1', 'user')).toBe(true)
    expect(isChatWhitelisted(whitelist, '42', 'supergroup')).toBe(true)
    expect(isChatWhitelisted(whitelist, '43', 'group')).toBe(false)
    expect(isChatWhitelisted(whitelist, '43')).toBe(false)
    expect(whitelist.cleanExcluded).toBe(true)
  })

  it('an enabled empty whitelist rejects all chats', () => {
    const whitelist = { ...generateDefaultAccountSettings().syncWhitelist, enabled: true }
    expect(isChatWhitelisted(whitelist, '42', 'user')).toBe(false)
  })

  it('waits for active writes before cleanup and continues after failures', async () => {
    const ctx = {} as CoreContext
    const events: string[] = []
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const write = withSyncWhitelistLock(ctx, async () => {
      await gate
      events.push('write')
    })
    const cleanup = withSyncWhitelistLock(ctx, async () => {
      events.push('cleanup')
      throw new Error('failed')
    })
    const failure = expect(cleanup).rejects.toThrow('failed')
    const next = withSyncWhitelistLock(ctx, async () => {
      events.push('next')
    })
    expect(events).toEqual([])
    finish()
    await Promise.all([write, failure, next])
    expect(events).toEqual(['write', 'cleanup', 'next'])
  })
})
