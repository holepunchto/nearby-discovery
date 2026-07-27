const { Central, Characteristic, Server, Service } = require('bare-bluetooth')
const EventEmitter = require('bare-events')

const SERVICE_UUID = 'B4A3C8A7-0000-1000-8000-00805F9B34FB'
const CHAR_UUID = 'B4A3C8A7-0004-1000-8000-00805F9B34FB' // keet-id characteristic

const isAndroid = Bare.platform === 'android'
const scanOptions = isAndroid ? { scanMode: Central.SCAN_MODE_LOW_LATENCY } : undefined

module.exports = class NearbyPeers extends EventEmitter {
  constructor({ serviceUUID = SERVICE_UUID, charUUID = CHAR_UUID } = {}) {
    super()
    this._localKey = null
    this._localName = null
    this.serviceUUID = serviceUUID
    this.charUUID = charUUID

    this.central = new Central()
    this.central.on('discover', this._oncentraldiscover.bind(this))
    this.central.on('connect', this._oncentralconnect.bind(this))
    this.central.on('disconnect', this._oncentraldisconnect.bind(this))
    this.central.on('error', this.emit.bind(this, 'error'))

    this.scanning = false
    this.discovered = new Map()
    this._peripheral = null

    this.announcing = false
    this.server = null
    this.idchr = null
    this.localService = null
  }

  async _initServer() {
    this.server = new Server()
    this.idchr = new Characteristic(this.charUUID, { read: true }) // BLE-ish for "port".

    this.server.on('stateChange', (blestate) => {
      console.log('server state', blestate, this.server.state)
    })
    this.server.on('readRequest', this._onreadrequest.bind(this))

    const done = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.once('serviceAdd', resolve)
    })

    // l2cap
    // this.server.on('channelPublish', (psm) => {})
    // this.server.on('channelOpen', (channel) => {})

    this.localService = new Service(this.serviceUUID, [this.idchr])
    this.server.addService(this.localService)

    await done

    this.server.on('error', this.emit.bind(this, 'error'))

    this.server.updateValue(this.idchr, this._localKey)
    this.server.startAdvertising({
      serviceUUIDs: [this.serviceUUID],
      name: this._localName
    })
  }

  async announce(id, { deviceName = 'keet-nearby' } = {}) {
    this._localName = deviceName
    this._localKey = id // TODO: normalize
    if (this.announcing) return

    this.announcing = true

    try {
      await this._initServer()
    } catch (err) {
      this.announcing = false
      throw err
    }

    this.announcing = true
  }

  _onreadrequest(req) {
    console.log('_onreadrequest', req)
    const value = this._localKey
    this.server.respondToRequest(req, Server.ATT_SUCCESS, value)
  }

  scan() {
    if (this.scanning) return
    this.scanning = true
    // this.scanTimeout = setTimeout(this.stopScan.bind(this), 20_000)
    console.log('starting scan')
    this._resumeScan()
  }
  _resumeScan() {
    this.central.startScan([this.serviceUUID], scanOptions)
  }

  _oncentraldiscover(discoveredPeripheral) {
    const peripheral = discoveredPeripheral // todo
    const peer = {
      ...(this.discovered.get(peripheral.id) || spawnPeer()),

      // update radio props
      peripheral,
      rssi: peripheral.rssi,
      deviceName: peripheral.name
    }

    peer.seenCount++
    peer.seenDate = Date.now()

    this.discovered.set(peripheral.id, peer)

    console.log('discovered:', peripheral.id, peripheral.name, peripheral.rssi)

    if (!this.scanning) return // TODO: bluez cache bug
    if (peer.key) return
    if (peer.ignore) return
    if (this._peripheral) return  // TODO: proper connect queue

    this._connect(peripheral.id)
  }

  _connect(id) {
    // TODO: pause/resume scan
    this.central.stopScan()

    const peer = this.discovered.get(id)
    const { peripheral } = peer
    if (!peripheral) throw new Error('unknown peripheral')

    peer.connectedAt = Date.now()
    peer.attempts++
    console.log('connect:', peripheral.id)

    this.central.connect(peripheral)
  }

  _oncentralconnect(peripheral) {
    console.log('connected:', peripheral.id, peripheral.name)
    this._peripheral = peripheral

    const { id } = peripheral

    let finished = false

    const finish = (disconnect = false, ban = false, error = null) => {
      console.log('finish()', finished, disconnect, ban, error)

      if (finished) return
      finished = true

      this._peripheral = null

      const peer = this.discovered.get(id)
      peer.ignore ||= ban
      peer.error = error

      // ignore after 3 failed attempts
      // if (peer.key && peer.attempts > 3) peer.ignore = true

      if (disconnect) this.central.disconnect(peripheral)

      peripheral.destroy()
    }

    peripheral.on('servicesDiscover', (services) => {
      console.log('servicesDiscover:', services.map((service) => service.uuid).join(', '))

      if (!services?.length) return // TODO: bug bare-bluetooth/lib/linux.js

      for (const service of services) {
        if (sameUUID(service.uuid, this.serviceUUID)) {
          peripheral.discoverCharacteristics(service, [this.charUUID])
          return
        }
      }

      console.error('service not found:', this.serviceUUID)
      finish(true, true, 'characteristic not found')
    })

    peripheral.on('characteristicsDiscover', (service, characteristics) => {
      console.log('characteristicsDiscover:', characteristics.map((char) => char.uuid).join(', '))

      if (!characteristics?.length) return // TODO: bug bare-bluetooth/lib/linux.js

      for (const characteristic of characteristics) {
        if (sameUUID(characteristic.uuid, this.charUUID)) {
          peripheral.read(characteristic)
          return
        }
      }

      console.error('characteristic not found:', this.charUUID)
      finish(true, true, 'characteristic not found')
    })

    peripheral.on('read', (characteristic, data) => {
      console.log('read:', characteristic.uuid)
      console.log('key', Buffer.from(data).toString('hex'))

      const peer = this.discovered.get(id)
      peer.key = data

      finish(true)
      this.emit('discovered', peer)
    })

    peripheral.on('disconnect', () => {
      console.log('peripheral disconnect')
      this.discovered.get(id).disconnectedAt = Date.now()

      finish(null) // TODO: is wrong
    })

    peripheral.on('error', (err) => {
      console.error('peripheral error:', err)
      this.emit('error', err) // unsure if should hoist
      finish(true, false, err)
    })

    peripheral.discoverServices([this.serviceUUID])
  }

  _oncentraldisconnect(peripheral) {
    console.log('_oncentraldisconnect()', peripheral.id)
    // TODO: move disconnectedAt = Date.now() here if signal stable.

    // TODO: this cleanup does not make sense - rework.
    if (this._peripheral) {
      console.log('post cleanup', this._peripheral.id)
      this.central.disconnect(this._peripheral)
      this._peripheral = null
    }

    setTimeout(() => this._resumeScan(), 2000)
  }

  destroy() {
    // TODO: destroy open peripherals?
    this.central.destroy()
  }
}

function normalizeUUID(uuid) {
  return String(uuid || '')
    .toLowerCase()
    .replace(/-/g, '')
}

function sameUUID(a, b) {
  return normalizeUUID(a) === normalizeUUID(b)
}

function spawnPeer() {
  return {
    key: null,
    rssi: null,
    deviceName: null,
    ignore: false,
    attempts: 0,
    connectedAt: null,
    disconnectedAt: null,
    seenDate: Date.now(),
    seenCount: 0,
    error: null,
    peripheral: null
  }
}


// Peripheral role: advertises the service, publishes an L2CAP channel and hands
// out its PSM. Emits 'link' with a PeerLink once a central opens the channel.
class BLEServer extends EventEmitter {
  constructor(opts) {
    super()
    this.serviceUUID = opts.serviceUUID
    this.psmUUID = opts.psmUUID

    this.advertising = ToggleState.OFF
    this.serviceAdded = false
    this._deviceName = null
    this._psm = null

    this.psmChar = new Characteristic(opts.psmUUID, { read: true })

    this._server = new Server()
    this._setup()
  }

  get state() {
    return this._server.state
  }

  _setup() {
    this._server.on('stateChange', (bleState) => {
      dbg('Server: stateChange', bleState)
      if (bleState === 'poweredOn') this._start()
    })

    this._server.on('serviceAdd', () => {
      dbg('Server: serviceAdd')
      this.serviceAdded = true
      this.emit('ready')
      if (this.advertising === ToggleState.REQUESTED) this.startAdvertising()
    })

    this._server.on('channelPublish', (psm) => {
      dbg('Server: channelPublish psm=', psm)
      this._psm = psm
      this.emit('log', `L2CAP channel published psm=${psm}`)
      if (this.advertising === ToggleState.REQUESTED) this.startAdvertising()
    })

    this._server.on('channelOpen', (channel) => {
      dbg('Server: channelOpen (invitee side)')
      this.emit('log', 'L2CAP channel open')
      this.emit('link', new PeerLink(channel))
    })

    // A central reads this to discover the PSM before opening the channel. The
    // PSM is a plain number, so send it as raw text (not JSON) — the central
    // parses it with Number().
    this._server.on('readRequest', (req) => {
      dbg('Server: readRequest (PSM) psm=', this._psm)
      const value = this._psm != null ? Buffer.from(String(this._psm)) : Buffer.alloc(0)
      this._server.respondToRequest(req, Server.ATT_SUCCESS, value)
    })

    this._server.on('error', (err) => {
      dbg('Server: error', err && err.code, err && err.message, err && err.stack)
      if (err.code === 'ADVERTISE_FAILED') {
        // Advertising never started: keep internal state in sync with the UI
        // (which flips the switch off) instead of a phantom 'requested' state.
        this.advertising = ToggleState.OFF
        this.emit('advertisingStopped')
      }
      this.emit('error', err.message || String(err))
    })

    this._start()
  }

  _start() {
    if (this._server.state !== 'poweredOn') return
    if (!this.serviceAdded) {
      this._server.addService(new Service(this.serviceUUID, [this.psmChar]))
    }
    if (this._psm == null) this._server.publishChannel()
  }

  startAdvertising(deviceName) {
    if (deviceName !== undefined) this._deviceName = deviceName
    if (this.advertising === ToggleState.ON) return

    if (this._server.state !== 'poweredOn') {
      this.emit('log', 'Advertising is waiting for Bluetooth power')
      return
    }

    // Both the GATT service (for PSM discovery) and the published PSM must be
    // ready before we invite centrals to connect.
    if (!this.serviceAdded || this._psm == null) {
      this._start()
      this.advertising = ToggleState.REQUESTED
      this.emit('log', 'Advertising is waiting for service and PSM')
      return
    }

    const opts = { serviceUUIDs: [this.serviceUUID] }
    // if (this._deviceName) opts.name = "xxx" // this._deviceName

    this.emit('log', `Starting advertising: ${this.serviceUUID}`)
    this._server.startAdvertising(opts)
    this.advertising = ToggleState.ON
    this.emit('advertisingStarted')
  }

  stopAdvertising() {
    this._server.stopAdvertising()
    this.advertising = ToggleState.OFF
    this.emit('advertisingStopped')
  }

  setAdvertising(enabled, deviceName) {
    if (enabled) {
      this._deviceName = deviceName
      this.advertising = ToggleState.REQUESTED
      this.startAdvertising()
    } else {
      this.stopAdvertising()
    }
  }

  destroy() {
    this._server.destroy()
  }
}
