import type { CoreContext } from '../context'
import type { JoinedChatType } from '../schemas/joined-chats'
import type { SyncWhitelist } from '../types/account-settings'

export function isChatWhitelisted(whitelist: SyncWhitelist | undefined, chatId: string, chatType?: JoinedChatType): boolean {
  return !whitelist?.enabled || whitelist.chatIds.includes(chatId)
    || (chatType != null && whitelist.chatTypes.includes(chatType))
}

// Settings cleanup and message writes must not race and restore excluded data.
const pending = new WeakMap<CoreContext, Promise<unknown>>()
export function withSyncWhitelistLock<T>(ctx: CoreContext, run: () => Promise<T>): Promise<T> {
  const result = (pending.get(ctx) ?? Promise.resolve()).then(run)
  pending.set(ctx, result.catch(() => {}))
  return result
}
