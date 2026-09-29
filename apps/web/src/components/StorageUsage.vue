<script setup lang="ts">
import type { StorageUsage } from '@tg-search/core'

import { subscribeStorageUsage, useAccountStore, useBridge, useSessionStore } from '@tg-search/client'
import { CoreEventType } from '@tg-search/core'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { Button } from './ui/Button'

const props = defineProps<{ chatId?: string, chatName?: string }>()
const { t, n } = useI18n()
const bridge = useBridge()
const accountStore = useAccountStore()
const sessionStore = useSessionStore()
const usage = ref<StorageUsage>()
const loading = ref(false)
const failed = ref(false)
let requestId: string | undefined
let unsubscribe: (() => void) | undefined
let timeout: ReturnType<typeof setTimeout> | undefined

function cacheKey() {
  return props.chatId && sessionStore.activeSessionId
    ? `storage-usage/v1/${sessionStore.activeSessionId}/${props.chatId}`
    : undefined
}

function restoreCachedUsage() {
  usage.value = undefined
  const key = cacheKey()
  if (!key)
    return
  try {
    const cached = localStorage.getItem(key)
    if (cached) {
      const parsed: StorageUsage = JSON.parse(cached)
      if (Number.isFinite(parsed.totalBytes))
        usage.value = parsed
    }
  }
  catch {
    // A damaged or unavailable browser cache should not prevent recalculation.
  }
}

function stopRequest() {
  if (requestId && props.chatId !== undefined)
    bridge.sendEvent(CoreEventType.StorageCancelUsage, { requestId })
  requestId = undefined
  unsubscribe?.()
  unsubscribe = undefined
  if (timeout)
    clearTimeout(timeout)
  timeout = undefined
  loading.value = false
}

onBeforeUnmount(stopRequest)

function armTimeout() {
  if (timeout)
    clearTimeout(timeout)
  timeout = setTimeout(() => {
    stopRequest()
    failed.value = true
  }, 120_000)
}

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const exponent = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0
  return `${n(bytes / 1024 ** exponent, { maximumFractionDigits: 1 })} ${units[exponent]}`
}

function refresh() {
  if (loading.value || !accountStore.isReady)
    return

  stopRequest()
  loading.value = true
  failed.value = false
  requestId = crypto.randomUUID()
  const activeRequestId = requestId
  unsubscribe = subscribeStorageUsage(activeRequestId, (data) => {
    if (requestId !== activeRequestId)
      return
    if (!data.usage) {
      stopRequest()
      failed.value = true
      return
    }
    usage.value = data.usage
    if (data.done) {
      const key = cacheKey()
      if (key) {
        try {
          localStorage.setItem(key, JSON.stringify(data.usage))
        }
        catch {
          // Storage may be unavailable or full; the current result still displays.
        }
      }
      stopRequest()
    }
    else {
      armTimeout()
    }
  })
  armTimeout()
  bridge.sendEvent(CoreEventType.StorageFetchUsage, { requestId: activeRequestId, chatId: props.chatId })
}

watch([() => accountStore.isReady, () => props.chatId, () => sessionStore.activeSessionId], ([ready]) => {
  stopRequest()
  failed.value = false
  restoreCachedUsage()
  if (ready && props.chatId === undefined)
    refresh()
}, { immediate: true })
</script>

<template>
  <section class="border rounded-xl bg-card p-4 space-y-2" :aria-busy="loading">
    <div class="flex items-center justify-between gap-3">
      <h2 class="min-w-0 text-base font-semibold">
        {{ chatId !== undefined ? t('storage.chatTitle', { name: chatName || chatId }) : t('storage.title') }}
      </h2>
      <Button variant="outline" size="sm" :disabled="loading || !accountStore.isReady" @click="refresh">
        {{ loading ? t(chatId !== undefined ? 'storage.calculating' : 'storage.loading') : chatId !== undefined && !usage ? t('storage.calculate') : t('storage.refresh') }}
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">
      {{ chatId !== undefined ? t('storage.chatDescription') : t('storage.description') }}
    </p>
    <div aria-live="polite">
      <p v-if="failed" role="alert" class="text-sm text-destructive">
        {{ t('storage.failed') }}
      </p>
      <dl v-else-if="usage" class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <dt class="text-muted-foreground">
            {{ t('storage.total') }}
          </dt>
          <dd class="text-lg font-semibold tabular-nums">
            {{ formatBytes(usage.totalBytes) }}
          </dd>
        </div>
        <template v-if="chatId !== undefined">
          <div>
            <dt class="text-muted-foreground">
              {{ t('storage.messages') }}
            </dt>
            <dd class="tabular-nums">
              {{ formatBytes(usage.messageBytes ?? 0) }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">
              {{ t('storage.photos') }}
            </dt>
            <dd class="tabular-nums">
              {{ formatBytes(usage.photoBytes ?? 0) }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">
              {{ t('storage.stickers') }}
            </dt>
            <dd class="tabular-nums">
              {{ formatBytes(usage.stickerBytes ?? 0) }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">
              {{ t('storage.media') }}
            </dt>
            <dd class="tabular-nums">
              {{ formatBytes(usage.mediaBytes ?? 0) }}
            </dd>
          </div>
        </template>
      </dl>
    </div>
    <p v-if="loading && chatId !== undefined && usage" class="text-xs text-muted-foreground">
      {{ t('storage.scanned', { count: usage.scannedMessages ?? 0 }) }}
    </p>
    <p v-if="!loading && usage?.missingMedia" class="text-xs text-muted-foreground">
      {{ t('storage.missingMedia', { count: usage.missingMedia }) }}
    </p>
  </section>
</template>
