import type { EventContext } from '@moeru/eventa'

import type { ApplicationBridge } from '../types/bridge'

import { defineInvokes } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/websocket/native'
import { chatContracts, messageContracts, statsContracts } from '@tg-search/protocol'

export function isEventaWebSocketFrame(data: unknown): boolean {
  if (typeof data !== 'string')
    return false

  try {
    const frame: unknown = JSON.parse(data)
    return typeof frame === 'object' && frame !== null && 'id' in frame
  }
  catch {
    return false
  }
}

export function createWebSocketApplicationBridge(getSocket: () => WebSocket | undefined): ApplicationBridge {
  let binding: { socket: WebSocket, context: EventContext<any, any>, dispose: () => void } | undefined

  function bindSocket(socket: WebSocket) {
    const facade: Pick<WebSocket, 'send' | 'url'> & {
      onclose: WebSocket['onclose']
      onerror: WebSocket['onerror']
      onmessage: WebSocket['onmessage']
      onopen: WebSocket['onopen']
    } = {
      url: socket.url,
      send: data => socket.send(data),
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
    }
    // The socket also carries legacy type/data notifications, which Eventa cannot decode.
    const forwardMessage = (event: MessageEvent) => {
      if (isEventaWebSocketFrame(event.data))
        facade.onmessage?.call(socket, event)
    }
    const forwardClose = (event: CloseEvent) => facade.onclose?.call(socket, event)
    const forwardError = (event: Event) => facade.onerror?.call(socket, event)
    socket.addEventListener('message', forwardMessage)
    socket.addEventListener('close', forwardClose)
    socket.addEventListener('error', forwardError)
    const context = createContext(facade as WebSocket).context
    return {
      socket,
      context,
      dispose: () => {
        socket.removeEventListener('message', forwardMessage)
        socket.removeEventListener('close', forwardClose)
        socket.removeEventListener('error', forwardError)
        context.abort(new Error('WebSocket application bridge disposed'))
      },
    }
  }

  function getInvokes() {
    const socket = getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }
    if (!binding || binding.socket !== socket) {
      binding?.dispose()
      binding = bindSocket(socket)
    }
    const eventContext = binding.context
    return {
      chats: defineInvokes(eventContext, chatContracts),
      messages: defineInvokes(eventContext, messageContracts),
      stats: defineInvokes(eventContext, statsContracts),
    }
  }

  return {
    listChats: input => getInvokes().chats.list(input),
    listRemoteMessages: input => getInvokes().messages.listRemote(input),
    queryLocalMessages: input => getInvokes().messages.queryLocal(input),
    searchLocalMessages: input => getInvokes().messages.searchLocal(input),
    getLocalMessageContext: input => getInvokes().messages.contextLocal(input),
    getLocalStats: input => getInvokes().stats.get(input),
    dispose: () => {
      binding?.dispose()
      binding = undefined
    },
  }
}
