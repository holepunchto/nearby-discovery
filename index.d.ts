import EventEmitter = require('bare-events')
import { L2CAPChannel } from 'bare-bluetooth'

declare class NearbyDiscovery extends EventEmitter<NearbyDiscoveryEventMap> {
  constructor(opts?: NearbyDiscoveryOptions)

  readonly serviceUUID: string
  readonly charUUID: string
  readonly streamUUID: string

  readonly announcing: boolean
  readonly discovering: boolean

  announce(key: Uint8Array, opts?: NearbyDiscoveryAnnounceOptions): Promise<void>
  discover(opts?: NearbyDiscoveryDiscoverOptions): void
  stopDiscover(): void
  destroy(): void

  [Symbol.dispose](): void
}

interface NearbyDiscoveryOptions {
  useStream?: boolean
  serviceUUID?: string
  charUUID?: string
  streamUUID?: string
  peerCache?: NearbyDiscoveryPeerCacheOptions
  flushDelay?: number
  scanOptions?: unknown
}

interface NearbyDiscoveryPeerCacheOptions {
  maxAge?: number
  maxSize?: number
}

interface NearbyDiscoveryAnnounceOptions {
  deviceName?: string
}

interface NearbyDiscoveryDiscoverOptions {
  timeout?: number
}

interface NearbyDiscoveryPeer {
  key: Uint8Array | null
  address: string | null
  rssi: number | null
  deviceName: string | null
  connectedAt: number | null
  disconnectedAt: number | null
  seenDate: number
  seenCount: number
  error: Error | string | null
}

interface NearbyDiscoveryStreamInfo {
  initiator: boolean
  address: string | null
}

interface NearbyDiscoveryEventMap extends EventEmitter.EventMap {
  discovered: [peer: NearbyDiscoveryPeer]
  stream: [channel: L2CAPChannel, info: NearbyDiscoveryStreamInfo]
  error: [error: Error]
}

export = NearbyDiscovery
