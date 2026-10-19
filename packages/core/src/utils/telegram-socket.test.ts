// @vitest-environment node
import type { Server, Socket } from 'node:net'

import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTelegramSocket } from './telegram-socket'

describe('telegram transport read recovery', () => {
  const logger = { warn: vi.fn() }
  const TelegramSocket = createTelegramSocket(logger)
  let server: Server
  let transport: InstanceType<typeof TelegramSocket>
  const peers = new Set<Socket>()
  let port: number

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server = createServer((peer) => {
      peers.add(peer)
      peer.once('close', () => peers.delete(peer))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener')
    port = address.port
    transport = new TelegramSocket()
    await transport.connect(port, '127.0.0.1')
  })

  afterEach(async () => {
    await transport.close()
    for (const peer of peers)
      peer.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('closes a stalled handshake read so the existing client can retry', async () => {
    // Telegram can leave SetClientDHParams unanswered during a DC migration.
    const closed = vi.spyOn(transport, 'close')
    const reading = transport.readExactly(1).catch(error => error)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(closed).toHaveBeenCalledOnce()
    expect(await reading).toBeInstanceOf(Error)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('30 seconds'))

    // GramJS retries using the same transport instance, without a second client.
    await transport.connect(port, '127.0.0.1')
    const retried = transport.readExactly(1)
    for (const peer of peers)
      peer.write('x')
    expect(await retried).toEqual(Buffer.from('x'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each successive packet read a fresh inactivity deadline', async () => {
    for (const character of ['a', 'b']) {
      const reading = transport.readExactly(1)
      await vi.advanceTimersByTimeAsync(29_000)
      for (const peer of peers)
        peer.write(character)
      expect(await reading).toEqual(Buffer.from(character))
      expect(vi.getTimerCount()).toBe(0)
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('clears the read deadline when the remote connection closes', async () => {
    const reading = transport.readExactly(1).catch(error => error)
    for (const peer of peers)
      peer.destroy()
    expect(await reading).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
