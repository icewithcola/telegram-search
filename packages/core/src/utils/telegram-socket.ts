import type { Buffer } from 'node:buffer'

import type { Logger } from '@guiiai/logg'

import { PromisedNetSockets } from 'telegram/extensions'

const READ_IDLE_TIMEOUT_MS = 30_000

export function createTelegramSocket(logger: Pick<Logger, 'warn'>): typeof PromisedNetSockets {
  return class extends PromisedNetSockets {
    override async read(number: number): Promise<Buffer> {
      // NOTICE: GramJS does not time out handshake reads, including DC migration.
      // Close the transport to settle the original read and let its existing
      // retry loop recover, rather than abandoning a live login with a race.
      const deadline = setTimeout(() => {
        logger.warn('Telegram socket received no data for 30 seconds; closing transport for retry')
        void this.close().catch(() => logger.warn('Failed to close stalled Telegram socket'))
      }, READ_IDLE_TIMEOUT_MS)

      try {
        return await super.read(number)
      }
      finally {
        clearTimeout(deadline)
      }
    }
  }
}
