import { CoreEventType } from '@tg-search/core'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '../useChat'

// Mock dependencies
const sendEventMock = vi.fn()
const listChatsMock = vi.fn(async () => ({ ok: true, data: { items: [], nextCursor: null } }))
vi.mock('../../composables/useBridge', () => ({
  useBridge: () => ({
    sendEvent: sendEventMock,
    application: { listChats: listChatsMock },
  }),
}))

vi.mock('../useSession', () => ({
  useSessionStore: vi.fn(() => ({
    activeSession: { me: { id: 12345 } },
  })),
}))

// Mock localStorage
const localStorageMock = new Map<string, any>()
vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>()
  return {
    ...actual,
    useLocalStorage: (key: string, initialValue: any) => {
      // Simple mock for useLocalStorage using a ref-like object
      let val = localStorageMock.get(key) ?? initialValue
      return {
        // Setter to update mock map
        set value(v: any) {
          localStorageMock.set(key, v)
          val = v
        },
        get value() {
          return val
        },
      }
    },
  }
})

describe('useChatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('initializes and fetches data', () => {
    const store = useChatStore()
    store.init()

    expect(sendEventMock).toHaveBeenCalledWith(CoreEventType.StorageFetchDialogs)
    expect(sendEventMock).toHaveBeenCalledWith(CoreEventType.DialogFoldersFetch)
    expect(listChatsMock).toHaveBeenCalledWith({ limit: 1000 })
  })

  it('manages chats correctly', () => {
    const store = useChatStore()
    const mockChats = [
      { id: 1, title: 'Chat 1', pinned: false, lastMessageDate: '2023-01-01' },
      { id: 2, title: 'Chat 2', pinned: true, lastMessageDate: '2023-01-02' },
    ]

    // @ts-expect-error - mock data
    store.chats = mockChats

    // Check getter logic (sorting)
    // Chat 2 is pinned, should be first
    expect(store.chats[0].id).toBe(2)
    expect(store.chats[1].id).toBe(1)
  })

  it('gets a specific chat', () => {
    const store = useChatStore()
    const mockChats = [
      { id: 1, name: 'Chat 1' },
      { id: 2, name: 'Chat 2' },
    ]
    // @ts-expect-error - mock data
    store.chats = mockChats

    const chat = store.getChat('1')
    expect(chat).toBeDefined()
    expect(chat?.name).toBe('Chat 1')
  })

  it('manages folders correctly', () => {
    const store = useChatStore()
    const mockFolders = [
      { id: 1, title: 'Folder 1', includedChatIds: [], excludedChatIds: [] },
    ]

    store.folders = mockFolders

    expect(store.folders).toHaveLength(1)
    expect(store.folders[0].title).toBe('Folder 1')
  })

  it('preserves folderIds from existing chats when merging Telegram-sourced dialogs', () => {
    const store = useChatStore()

    // Simulate DB-sourced dialogs (with folderIds)
    store.mergeDialogs([
      { id: 1, name: 'Chat 1', type: 'group', folderIds: [10, 20], includedChatIds: [], excludedChatIds: [] } as any,
      { id: 2, name: 'Chat 2', type: 'channel', folderIds: [10], includedChatIds: [], excludedChatIds: [] } as any,
    ])

    // Simulate Telegram-sourced dialogs (without folderIds or with empty folderIds)
    store.mergeDialogs([
      { id: 1, name: 'Chat 1', type: 'group', folderIds: [] } as any,
      { id: 2, name: 'Chat 2', type: 'channel' } as any,
    ])

    const chat1 = store.chats.find(c => c.id === 1)
    const chat2 = store.chats.find(c => c.id === 2)

    // folderIds should be preserved from the DB-sourced dialogs
    expect(chat1?.folderIds).toEqual([10, 20])
    expect(chat2?.folderIds).toEqual([10])
  })
})
