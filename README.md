# nearby-discovery

Discover nearby values and peers

## Usage

```js
const Nearby = require('nearby-discovery')

using service = new Nearby()

// announce local service

const localKey = Buffer.alloc(32).fill('hello')
await service.announce(localKey)

// scan & connect to nearby services

service.on('discovered', (peer) => {
  const remoteKey = peer.key
  console.log('peer discovered', remoteKey, peer)
})

service.on('error', console.error)
service.discover()
```

Experimental duplex streams:

```js
const Nearby = require('nearby-discovery')
const Hypercore = require('hypercore')

const core = new Hypercore('tmp')
await core.ready()

const service = new Nearby({ useStream: true })
await service.announce(core.key)

service.on('stream', (stream, { initiator }) => {
  const r = core.replicate(initiator)
  r.pipe(stream).pipe(r)
})
```

## API

Some underlying calls might be blocking depending on platform,
(don't run this module on main thread).

Use a worker thread in production.

### `const service = new Nearby(opts = {})`

- `opts.useStream` `false` - (experimental) Prefer opening l2cap channels instead of Key characteristic.
- `opts.serviceUUID` `string` - BLE service UUID to announce/search for
- `opts.charUUID` `string` - Key BLE characteristic
- `opts.streamUUID` Stream BLE characteristic

### `await service.announce(key, opts = {})`

Initializes BLE server and begins announcing local service+characteristic; Required for incoming requests.

- `key` `Buffer` the value to respond with on incoming characteristic connction.
- `opts.deviceName` `string` short device name announced in beacons; default: `peer`

### `service.on('discovered', peer)`

Fired after `service.discover()` on successful key transfer.

_main_

- `peer.key` `Buffer` - the remote peer's announced key.
- `peer.address` `string`- Bluetooth device address
- `peer.deviceName` `string` - the remote device's advertised name.

_details_

- `peer.address` `string` - remote address
- `peer.rssi` `number` - signal strength
- `peer.connectedAt` `number|null`
- `peer.disconnectedAt` `number|null`
- `peer.seenDate` `number`
- `peer.seenCount` `number`

### `service.discover(opts = {})`

Starts scanning for nearby peers, connects to matching devices, and reads their key characteristic.

- `opts.timeout` `number` - optional scan timeout in milliseconds; default: `0` disables the timeout.

### `service.stopDiscover()`

Stops active discovery/scanning.

### `service.on('stream', (channel, { initiator, address }) => {})`

Fired when a new channel is opened

- `channel` duplex stream
- `opts.initiator` `boolean` true when initiated from local
- `opts.address` `string|null` remote bluetooth address, a.k.a peripheral id

## License

Apache-2.0
