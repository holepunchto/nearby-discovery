# nearby-discovery

Discover nearby values and peers

## Usage

```
const Nearby = require('.')

using service = new Nearby()

// announce local service

const localKey = Buffer.alloc(32).fill('hello')
await service.announce(localKey)

// scan & connect to nearby services

service.on('discovered', peer => {
  const remoteKey = peer.key
  console.log('peer discovered', remoteKey, peer)
})

service.on('error', console.error)
service.discover()
```

## API

Some underlying calls might be blocking depending on platform,
(don't run this module on main thread).

Use a worker thread in production.

### `const service = new Nearby(opts = {})`

- `opts.serviceUUID` `string` - BLE service UUID to announce/search for
- `opts.charUUID` `string` - Key BLE characteristic

### `await service.announce(key, opts = {})`

Initializes BLE server and begins announcing local service+characteristic; Required for incoming requests.

- `key` `Buffer` the value to respond with on incoming characteristic connction.
- `opts.deviceName` `string` short device name announced in beacons; default: `keet-nearby`

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

## TODO

- rename repo to `nearby-discovery` with 2 modes of operation:
- GATT `key` discovery
- L2Cap `stream` exposed as `peer.stream` + `connection` event. (support missing, `bare-bluetooth-linux`)

## License

Apache-2.0
