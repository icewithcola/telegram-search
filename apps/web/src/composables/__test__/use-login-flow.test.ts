import { createPinia, defineStore, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

import { useLoginFlow } from '../useLoginFlow'

const login = vi.hoisted(() => vi.fn())
const useTestAccount = defineStore('login-test-account', {
  state: () => ({ auth: { needCode: false, needPassword: false, isLoading: false }, isReady: false }),
  actions: {
    handleAuth: () => ({ login, submitCode: vi.fn(), submitPassword: vi.fn() }),
  },
})
const useTestSession = defineStore('login-test-session', {
  state: () => ({ activeSession: undefined }),
})

vi.mock('@tg-search/client', () => ({
  useAccountStore: () => useTestAccount(),
  useSessionStore: () => useTestSession(),
  useAvatarStore: () => ({ ensureUserAvatar: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: {} }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn() } }))

let pinia: ReturnType<typeof createPinia>
let scope: ReturnType<typeof effectScope>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  scope = effectScope()
  login.mockReset()
})
afterEach(() => {
  scope.stop()
  disposePinia(pinia)
})

describe('login flow recovery', () => {
  it.each([
    { flag: 'needCode', step: 'code' },
    { flag: 'needPassword', step: 'password' },
  ] as const)('restores $step when its prompt arrived before the form mounted', ({ flag, step }) => {
    const account = useTestAccount()
    account.auth[flag] = true
    // Lazy login forms used to erase prompts already received by the account store.
    const flow = scope.run(useLoginFlow)!
    expect(flow.state.value.currentStep).toBe(step)
    expect(account.auth[flag]).toBe(true)
  })

  it('preserves an in-flight login while mounting the form', () => {
    const account = useTestAccount()
    account.auth.isLoading = true
    scope.run(useLoginFlow)
    expect(account.auth.isLoading).toBe(true)
  })

  it('shows a replayed code prompt after going back to the phone form', async () => {
    const account = useTestAccount()
    const flow = scope.run(useLoginFlow)!
    account.auth.needCode = true
    await nextTick()
    flow.state.value.currentStep = 'phone'
    account.auth.needCode = false
    account.auth.needCode = true
    await nextTick()
    expect(flow.state.value.currentStep).toBe('code')
  })

  it('returns to phone login when a pending prompt is invalidated', () => {
    const account = useTestAccount()
    account.auth.needCode = true
    const flow = scope.run(useLoginFlow)!
    expect(flow.state.value.currentStep).toBe('code')
    account.auth.needCode = false
    expect(flow.state.value.currentStep).toBe('phone')
  })

  it('clears the spinner if sending login fails', async () => {
    const account = useTestAccount()
    const flow = scope.run(useLoginFlow)!
    login.mockImplementation(() => {
      throw new Error('WebSocket is not connected')
    })
    await flow.handleLogin()
    expect(account.auth.isLoading).toBe(false)
  })
})
