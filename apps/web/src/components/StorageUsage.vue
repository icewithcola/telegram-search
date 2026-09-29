<script setup lang="ts">
import type { StorageUsage } from '@tg-search/core'

import { useAccountStore, useBridge, waitForEventWithTimeout } from '@tg-search/client'
import { CoreEventType } from '@tg-search/core'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { Button } from './ui/Button'

const props = defineProps<{ chatId?: string, chatName?: string }>()
const { t, n } = useI18n()
const bridge = useBridge()
const accountStore = useAccountStore()
const usage = ref<StorageUsage>()
const loading = ref(false)
const failed = ref(false)
let generation = 0
onBeforeUnmount(() => {
  generation += 1
})

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const exponent = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0
  return `${n(bytes / 1024 ** exponent, { maximumFractionDigits: 1 })} ${units[exponent]}`
}

async function refresh() {
  if (loading.value || !accountStore.isReady)
    return

  const currentGeneration = ++generation
  loading.value = true
  failed.value = false
  try {
    const requestId = crypto.randomUUID()
    const response = waitForEventWithTimeout(bridge.waitForEvent(CoreEventType.StorageUsage, data => data.requestId === requestId), 30_000)
    bridge.sendEvent(CoreEventType.StorageFetchUsage, { requestId, chatId: props.chatId })
    const data = await response
    if (generation !== currentGeneration)
      return
    if (!data.usage)
      throw new Error(data.error)
    usage.value = data.usage
  }
  catch {
    if (generation !== currentGeneration)
      return
    failed.value = true
    usage.value = undefined
  }
  finally {
    if (generation === currentGeneration)
      loading.value = false
  }
}

watch(() => accountStore.isReady, (ready) => {
  if (ready) {
    void refresh()
  }
  else {
    generation += 1
    loading.value = false
    failed.value = false
    usage.value = undefined
  }
}, { immediate: true })
</script>

<template>
  <section class="border rounded-xl bg-card p-4 space-y-2" :aria-busy="loading">
    <div class="flex items-center justify-between gap-3">
      <h2 class="min-w-0 text-base font-semibold">
        {{ chatId !== undefined ? t('storage.chatTitle', { name: chatName || chatId }) : t('storage.title') }}
      </h2>
      <Button variant="outline" size="sm" :disabled="loading || !accountStore.isReady" @click="refresh">
        {{ loading ? t('storage.loading') : t('storage.refresh') }}
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
        </template>
      </dl>
    </div>
  </section>
</template>
