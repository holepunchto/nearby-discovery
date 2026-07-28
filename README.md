# keet-nearby

discovery of nearby peers

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
service.scan()
```


## API

Don't run this module on your main thread as some underlying calls might
be blocking depending on platform.

Use a worker thread in production.


### `const service = new Nearby(opts = {})`

- `opts.serviceUUID` `string` - BLE service UUID to announce/search for
- `opts.charUUID` `string` - Key BLE characteristic

### `await service.announce(key, opts = {})`

Initializes BLE server and begins announcing local service+characteristic; Required for incoming requests.

- `key` `Buffer` the value to respond with on incoming characteristic connction.
- `opts.deviceName` `string` short device name announced in beacons; default: `keet-nearby`

### `service.on('discovered', peer)`

Fired after `service.scan()` on successful key transfer.

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

## TODO
- rename repo to `nearby-discovery` with 2 modes of operation:
 - GATT `key` discovery
 - L2Cap `stream` exposed as `peer.stream` + `connection` event. (support missing, `bare-bluetooth-linux`)

## License

Apache-2.0
