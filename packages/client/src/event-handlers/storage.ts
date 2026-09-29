import type { ClientRegisterEventHandler } from '.'
import type { StorageEventFromCore } from '@tg-search/core'

import { useLogger } from '@guiiai/logg'
import { CoreEventType } from '@tg-search/core'

import { useChatStore } from '../stores/useChat'
import { prefillChatAvatarIntoStore } from '../utils/avatar-cache'

type UsageEvent = Parameters<StorageEventFromCore[CoreEventType.StorageUsage]>[0]
const usageListeners = new Map<string, (data: UsageEvent) => void>()

export function subscribeStorageUsage(requestId: string, listener: (data: UsageEvent) => void): () => void {
  usageListeners.set(requestId, listener)
  return () => usageListeners.delete(requestId)
}

/**
 * Register storage-related client event handlers.
 * Handles dialogs/messages hydration and batch-prefills chat avatars from IndexedDB for faster initial UX.
 */
export function registerStorageEventHandlers(
  registerEventHandler: ClientRegisterEventHandler,
) {
  registerEventHandler(CoreEventType.StorageDialogs, (data) => {
    const chatStore = useChatStore()
    chatStore.mergeDialogs(data.dialogs, { preserveUnreadCount: true })
    // Prefill avatars from persistent cache concurrently for better initial UX
    Promise.resolve().then(async () => {
      try {
        await Promise.all(chatStore.chats.map(chat => prefillChatAvatarIntoStore(chat.id)))
      }
      catch (error) {
        // Warn-only logging to comply with lint rules
        useLogger('storage:dialogs').withError(error).warn('Batch prefillChatAvatarIntoStore failed')
      }
    })
  })

  registerEventHandler(CoreEventType.StorageUsage, (data) => {
    usageListeners.get(data.requestId)?.(data)
  })

  // Wait for result event
  registerEventHandler(CoreEventType.StorageSearchMessagesData, (_) => {})
  registerEventHandler(CoreEventType.StorageMessageEditMarks, (_) => {})
  registerEventHandler(CoreEventType.StorageChatNoteData, (_) => {})
  registerEventHandler(CoreEventType.StorageSearchPhotosData, (_) => {})
}
