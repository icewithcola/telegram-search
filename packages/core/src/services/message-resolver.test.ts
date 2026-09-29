import type { CoreContext } from '../context'
import type { MessageResolverRegistryFn } from '../message-resolvers'

import bigInt from 'big-integer'

import { useLogger } from '@guiiai/logg'
import { Ok } from '@unbird/result'
import { EventEmitter } from 'eventemitter3'
import { Api } from 'telegram'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatMessageModels } from '../models/chat-message'
import { chatModels } from '../models/chats'
import { CoreEventType } from '../types/events'
import { generateDefaultAccountSettings } from '../utils/account-settings'
import { createMessageResolverService } from './message-resolver'

afterEach(() => vi.restoreAllMocks())

describe('message resolver whitelist', () => {
  it.each([false, true])('acknowledges excluded batches without writing or resolving media (takeout=%s)', async (takeout) => {
    const settings = generateDefaultAccountSettings()
    settings.syncWhitelist.enabled = true
    const emitter = new EventEmitter()
    const ctx = {
      emitter,
      getAccountSettings: async () => settings,
      getCurrentAccountId: () => 'account',
      getDB: () => ({}),
    } as unknown as CoreContext
    vi.spyOn(chatModels, 'fetchChatsByAccountId').mockResolvedValue(Ok([]) as never)
    const record = vi.spyOn(chatMessageModels, 'recordMessages').mockResolvedValue([])
    const media = vi.fn()
    const resolvers = { registry: new Map([['media', { run: media }]]) } as unknown as MessageResolverRegistryFn
    const processed = vi.fn()
    emitter.on(CoreEventType.MessageProcessed, processed)
    const service = createMessageResolverService(ctx, useLogger(), resolvers)
    await service.processMessages([new Api.Message({
      id: 1,
      peerId: new Api.PeerUser({ userId: bigInt(42) }),
      fromId: new Api.PeerUser({ userId: bigInt(42) }),
      date: 100,
      message: 'excluded',
    })], { batchId: 'batch', takeout })
    expect(record).not.toHaveBeenCalled()
    expect(media).not.toHaveBeenCalled()
    expect(processed).toHaveBeenCalledWith({ batchId: 'batch', count: 0, resolverSpans: [] })
  })
})
