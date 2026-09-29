import type { Logger } from '@guiiai/logg'

import type { CoreContext } from '../context'
import type { AccountSettings } from '../types'

import { safeParse } from 'valibot'

import { chatMessageModels } from '../models/chat-message'
import { accountSettingsSchema } from '../types'
import { CoreEventType } from '../types/events'
import { normalizeAccountSettings } from '../utils/account-settings'
import { withSyncWhitelistLock } from '../utils/sync-whitelist'

export type AccountSettingsService = ReturnType<typeof createAccountSettingsService>

export function createAccountSettingsService(ctx: CoreContext, logger: Logger) {
  logger = logger.withContext('core:account-settings:service')

  async function fetchAccountSettings() {
    logger.verbose('Fetching account settings')

    const accountSettings = normalizeAccountSettings(await ctx.getAccountSettings())

    ctx.emitter.emit(CoreEventType.ConfigData, { accountSettings })
  }

  async function setAccountSettings(accountSettings: AccountSettings) {
    const normalizedSettings = normalizeAccountSettings(accountSettings)

    const parsedAccountSettings = safeParse(accountSettingsSchema, normalizedSettings)
    // TODO: handle error
    if (!parsedAccountSettings.success) {
      throw new Error('Invalid config')
    }

    await withSyncWhitelistLock(ctx, async () => {
      await ctx.setAccountSettings(parsedAccountSettings.output)
      const whitelist = parsedAccountSettings.output.syncWhitelist
      if (whitelist.enabled && whitelist.cleanExcluded) {
        await chatMessageModels.cleanOutsideWhitelist(ctx.getDB(), ctx.getCurrentAccountId(), whitelist)
        ctx.emitter.emit(CoreEventType.StorageFetchDialogs, { accountId: ctx.getCurrentAccountId() })
      }
    })

    ctx.emitter.emit(CoreEventType.ConfigData, { accountSettings: parsedAccountSettings.output })
  }

  return {
    fetchAccountSettings,
    setAccountSettings,
  }
}
