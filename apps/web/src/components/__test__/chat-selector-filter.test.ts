// @vitest-environment happy-dom

import type { CoreChatFolder, CoreDialog } from '@tg-search/core/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'

import ChatSelector from '../ChatSelector.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))

vi.mock('../avatar/EntityAvatar.vue', () => ({
  default: defineComponent({ template: '<span />' }),
}))

vi.mock('virtua/vue', () => ({
  VList: defineComponent({
    props: ['data'],
    setup: (props, { slots }) => () => h('div', props.data.map((item: unknown) => slots.default?.({ item }))),
  }),
}))

const chats: CoreDialog[] = [
  { id: 1, name: 'Alpha group', type: 'group' },
  { id: 2, name: 'Beta group', type: 'supergroup' },
  { id: 3, name: 'Excluded group', type: 'group', folderIds: [10] },
  { id: 4, name: 'Included channel', type: 'channel' },
  { id: 5, name: 'Pinned user', type: 'user' },
  { id: 6, name: 'Unrelated channel', type: 'channel' },
  { id: 7, name: 'Assigned user', type: 'user', folderIds: [10] },
]
const folders: CoreChatFolder[] = [
  { id: 10, title: 'My groups', groups: true, includedChatIds: [4], pinnedChatIds: [5], excludedChatIds: [3] },
  { id: 11, title: 'Empty folder', includedChatIds: [], excludedChatIds: [] },
]

describe('sync chat selector folders', () => {
  let app: ReturnType<typeof createApp>
  let host: HTMLElement

  afterEach(() => {
    app?.unmount()
    host?.remove()
  })

  it('uses folder rules and keeps search and visible selection scope in sync', async () => {
    const visibleChatIds = ref<number[]>([])
    app = createApp({
      setup: () => () => h(ChatSelector, {
        chats,
        folders,
        selectedChats: [],
        'onUpdate:visibleChatIds': (ids: number[]) => {
          visibleChatIds.value = ids
        },
      }),
    })
    host = document.createElement('div')
    document.body.append(host)
    app.mount(host)
    await nextTick()

    async function selectFolder(label: string) {
      const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === label)
      expect(button).toBeTruthy()
      button!.click()
      await nextTick()
    }

    expect(visibleChatIds.value).toEqual([1, 2, 3, 4, 5, 6, 7])
    await selectFolder('My groups')
    // Telegram folder membership can come from rules or explicit lists without chat.folderIds.
    expect(visibleChatIds.value).toEqual([1, 2, 4, 5, 7])
    expect(host.textContent).toContain('Alpha group')
    expect(host.textContent).not.toContain('Excluded group')
    expect(host.textContent).not.toContain('Unrelated channel')

    const input = host.querySelector('input')!
    input.value = 'Beta'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(visibleChatIds.value).toEqual([2])

    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await selectFolder('Empty folder')
    expect(visibleChatIds.value).toEqual([])
    await selectFolder('chatGroups.all')
    expect(visibleChatIds.value).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
