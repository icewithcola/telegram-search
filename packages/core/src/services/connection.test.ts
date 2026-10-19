import { EventEmitter } from 'eventemitter3'
import { Api } from 'telegram'
import { RPCError } from 'telegram/errors'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CoreEventType } from '../types/events'
import { createConnectionService } from './connection'

const telegramMock = vi.hoisted(() => {
  const clients: TelegramClient[] = []
  const nextConnect: Array<() => Promise<boolean>> = []
  const nextAuthorization: boolean[] = []
  const nextStateErrors: Error[] = []
  const nextDestroy: Array<() => Promise<void>> = []
  const nextSignIn: Array<(credentials: unknown, callbacks: {
    phoneCode: () => Promise<string>
    password: () => Promise<string>
  }) => Promise<unknown>> = []

  class TelegramClient {
    connected = false
    connect: ReturnType<typeof vi.fn>
    isUserAuthorized: ReturnType<typeof vi.fn>
    invoke: ReturnType<typeof vi.fn>
    signInUser: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    session: { save: ReturnType<typeof vi.fn>, delete: ReturnType<typeof vi.fn> }

    constructor() {
      this.connect = vi.fn(nextConnect.shift() ?? (async () => true))
      this.isUserAuthorized = vi.fn(async () => nextAuthorization.shift() ?? true)
      this.invoke = vi.fn(async () => {
        const error = nextStateErrors.shift()
        if (error)
          throw error
      })
      this.signInUser = vi.fn(nextSignIn.shift())
      this.destroy = vi.fn(nextDestroy.shift() ?? (async () => undefined))
      this.session = { save: vi.fn(async () => 'saved-session'), delete: vi.fn() }
      clients.push(this)
    }
  }

  return { clients, nextAuthorization, nextConnect, nextStateErrors, nextDestroy, nextSignIn, TelegramClient }
})

vi.mock('telegram', () => ({
  Api: { auth: { LogOut: class {} }, updates: { GetState: class {} } },
  TelegramClient: telegramMock.TelegramClient,
}))

vi.mock('telegram/network', () => ({ ConnectionTCPObfuscated: class {} }))

vi.mock('telegram/sessions', () => ({
  StringSession: class {
    constructor(_session?: string) {}
  },
}))

function createContext() {
  const emitter = new EventEmitter()
  return {
    emitter,
    setClient: vi.fn(),
    withError: vi.fn((error: unknown) => error instanceof Error ? error : new Error(String(error))),
  }
}

const logger = {
  withContext: vi.fn(),
  withFields: vi.fn(),
  verbose: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  withError: vi.fn(),
}
logger.withContext.mockReturnValue(logger)
logger.withFields.mockReturnValue(logger)
logger.withError.mockReturnValue(logger)

function createService() {
  const ctx = createContext()
  const service = createConnectionService(ctx as never, logger as never, { apiId: 1, apiHash: 'hash' })
  return { ctx, service }
}

afterEach(() => {
  telegramMock.clients.length = 0
  telegramMock.nextAuthorization.length = 0
  telegramMock.nextConnect.length = 0
  telegramMock.nextStateErrors.length = 0
  telegramMock.nextDestroy.length = 0
  telegramMock.nextSignIn.length = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('connection service login lifecycle', () => {
  it.each([
    { prompt: CoreEventType.AuthCodeNeeded, input: CoreEventType.AuthCode, field: 'code', callback: 'phoneCode' },
    { prompt: CoreEventType.AuthPasswordNeeded, input: CoreEventType.AuthPassword, field: 'password', callback: 'password' },
  ] as const)('replays a pending $field prompt when phone login is requested again', async ({ prompt, input, field, callback }) => {
    const { ctx, service } = createService()
    const needed = vi.fn()
    ctx.emitter.on(prompt, needed)
    const waiting = new Promise<void>(resolve => ctx.emitter.once(prompt, resolve))
    telegramMock.nextAuthorization.push(false)
    telegramMock.nextSignIn.push(async (_credentials, callbacks) => {
      await callbacks[callback]()
      return {}
    })
    const first = service.loginWithPhone('+15555550123')
    await waiting
    // A reconnect/retry used to share the waiting promise without resending the lost prompt.
    const replay = service.loginWithPhone('+15555550123')
    expect(needed).toHaveBeenCalledTimes(2)
    expect(telegramMock.clients).toHaveLength(1)
    ctx.emitter.emit(input, { [field]: 'test-input' })
    await Promise.all([first, replay])
    expect(ctx.setClient).toHaveBeenCalledOnce()
    expect(ctx.emitter.listenerCount(input)).toBe(0)
  })

  it('registers the code listener before notifying the client', async () => {
    const { ctx, service } = createService()
    telegramMock.nextAuthorization.push(false)
    telegramMock.nextSignIn.push(async (_credentials, callbacks) => {
      expect(await callbacks.phoneCode()).toBe('12345')
      return {}
    })
    // Browser-local bridges can answer synchronously, before emit returns.
    ctx.emitter.on(CoreEventType.AuthCodeNeeded, () => ctx.emitter.emit(CoreEventType.AuthCode, { code: '12345' }))
    expect((await service.loginWithPhone('+15555550123')).orUndefined()).toBe(telegramMock.clients[0])
  })

  it('reuses the authorized client when login is replayed before account readiness', async () => {
    const { ctx, service } = createService()
    const connected = vi.fn()
    ctx.emitter.on(CoreEventType.AuthConnected, connected)
    // Login can be replayed after authorization while AccountReady bootstrap is still running.
    const first = await service.loginWithSession('session')
    const replay = await service.loginWithSession('session')

    expect(replay.orUndefined()).toBe(first.orUndefined())
    expect(telegramMock.clients).toHaveLength(1)
    expect(ctx.setClient).toHaveBeenCalledOnce()
    expect(connected).toHaveBeenCalledOnce()
  })

  it('reuses a phone-authorized client for session login', async () => {
    const { service } = createService()
    const first = await service.loginWithPhone('+15555550123')
    const replay = await service.loginWithSession('saved-session')

    expect(replay.orUndefined()).toBe(first.orUndefined())
    expect(telegramMock.clients).toHaveLength(1)
  })

  it('destroys a logged-out client before allowing a new login', async () => {
    const { service } = createService()
    await service.loginWithSession('session')
    const client = telegramMock.clients[0]!
    await service.logout(client as never)
    await service.loginWithPhone('+15555550123')

    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.session.delete).toHaveBeenCalledOnce()
    expect(telegramMock.clients).toHaveLength(2)
  })

  it('destroys the client even when the Telegram logout request fails', async () => {
    const { service, ctx } = createService()
    const disconnected = vi.fn()
    ctx.emitter.on(CoreEventType.AuthDisconnected, disconnected)
    await service.loginWithSession('session')
    const client = telegramMock.clients[0]!
    client.connected = true
    telegramMock.nextStateErrors.push(new Error('network failed'))

    await expect(service.logout(client as never)).rejects.toThrow('network failed')

    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.session.delete).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
    await service.loginWithPhone('+15555550123')
    expect(telegramMock.clients).toHaveLength(2)
  })

  it.each(['connect', 'invoke'] as const)('invalidates a duplicated auth key reported by %s', async (stage) => {
    const { ctx, service } = createService()
    const disconnected = vi.fn()
    const updateSession = vi.fn()
    ctx.emitter.on(CoreEventType.AuthDisconnected, disconnected)
    ctx.emitter.on(CoreEventType.SessionUpdate, updateSession)
    const error = new RPCError('AUTH_KEY_DUPLICATED', new Api.updates.GetState(), 406)
    if (stage === 'connect') {
      telegramMock.nextConnect.push(async () => {
        throw error
      })
    }
    else {
      telegramMock.nextStateErrors.push(error)
    }

    const result = await service.loginWithSession('session')

    expect(result.orUndefined()).toBeUndefined()
    expect(telegramMock.clients[0]!.destroy).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
    expect(updateSession).toHaveBeenCalledWith({ session: '' })
    expect(ctx.withError).toHaveBeenCalledWith(error, expect.stringContaining('Sign in again'))
  })

  it('notifies recovery only after slow failed-login cleanup has finished', async () => {
    vi.useFakeTimers()
    const { ctx, service } = createService()
    const authError = vi.fn(() => {
      setTimeout(() => {
        void service.loginWithSession('session')
      }, 2000)
    })
    ctx.emitter.on(CoreEventType.AuthError, authError)
    telegramMock.nextConnect.push(async () => {
      throw new Error('network failed')
    })
    telegramMock.nextDestroy.push(() => new Promise(resolve => setTimeout(resolve, 5000)))
    const first = service.loginWithSession('session')
    await vi.advanceTimersByTimeAsync(4000)
    expect(authError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    await first
    expect(telegramMock.clients).toHaveLength(2)
    expect(ctx.setClient).toHaveBeenCalledWith(telegramMock.clients[1])
  })
  it('allows Telegram client retries to complete after the former five-second deadline', async () => {
    vi.useFakeTimers()
    const { ctx, service } = createService()
    telegramMock.nextConnect.push(() => new Promise(resolve => setTimeout(() => resolve(true), 5_100)))
    const login = service.loginWithSession('session')

    await vi.advanceTimersByTimeAsync(5_100)

    expect((await login).orUndefined()).toBe(telegramMock.clients[0])
    expect(ctx.setClient).toHaveBeenCalledTimes(1)
  })

  it('destroys a client when connecting fails', async () => {
    const { service } = createService()
    telegramMock.nextConnect.push(async () => {
      throw new Error('network failed')
    })
    const login = service.loginWithSession('session')

    expect((await login).orUndefined()).toBeUndefined()
    expect(telegramMock.clients[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('returns an error and destroys a client when connect reports false', async () => {
    const { service } = createService()
    telegramMock.nextConnect.push(async () => false)

    const result = await service.loginWithSession('session')

    expect(result.orUndefined()).toBeUndefined()
    expect(telegramMock.clients[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('destroys an unauthorized session client', async () => {
    const { service, ctx } = createService()
    const disconnected = vi.fn()
    ctx.emitter.on(CoreEventType.AuthDisconnected, disconnected)
    telegramMock.nextAuthorization.push(false)
    telegramMock.nextStateErrors.push(new RPCError('AUTH_KEY_UNREGISTERED', new Api.updates.GetState(), 401))
    const login = service.loginWithSession('session')

    expect((await login).orUndefined()).toBeUndefined()
    expect(telegramMock.clients[0]!.destroy).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('preserves the distinction between a failed authorization request and a revoked session', async () => {
    const { service, ctx } = createService()
    const disconnected = vi.fn()
    const authError = vi.fn()
    ctx.emitter.on(CoreEventType.AuthDisconnected, disconnected)
    ctx.emitter.on(CoreEventType.AuthError, authError)
    telegramMock.nextStateErrors.push(new Error('TIMEOUT'))
    telegramMock.nextAuthorization.push(false)

    await service.loginWithSession('session')

    expect(authError).toHaveBeenCalledOnce()
    expect(disconnected).not.toHaveBeenCalled()
    expect(ctx.setClient).not.toHaveBeenCalled()
    expect(telegramMock.clients[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('keeps a client retained after AuthConnected handling throws', async () => {
    const { ctx, service } = createService()
    ctx.emitter.on(CoreEventType.AuthConnected, () => {
      throw new Error('bootstrap failed')
    })

    const result = await service.loginWithSession('session')

    expect(result.orUndefined()).toBeUndefined()
    expect(ctx.setClient).toHaveBeenCalledWith(telegramMock.clients[0])
    expect(telegramMock.clients[0]!.destroy).not.toHaveBeenCalled()
  })

  it('shares one login attempt across session and phone entry points', async () => {
    const { ctx, service } = createService()
    const first = service.loginWithSession('session')
    const second = service.loginWithPhone('+15555550123')

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(telegramMock.clients).toHaveLength(1)
    expect(ctx.setClient).toHaveBeenCalledOnce()
  })
})
