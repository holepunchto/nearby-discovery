const { Central } = require('bare-bluetooth')
const EventEmitter = require('bare-events')

const SERVICE_UUID = 'B4A3C8A7-0000-1000-8000-00805F9B34FB'
const CHAR_UUID = 'B4A3C8A7-0004-1000-8000-00805F9B34FB' // keet-id characteristic

const isAndroid = Bare.platform === 'android'
const scanOptions = isAndroid ? { scanMode: Central.SCAN_MODE_LOW_LATENCY } : undefined

module.exports = class NearbyPeers extends EventEmitter {
  constructor({ serviceUUID = SERVICE_UUID, charUUID = CHAR_UUID } = {}) {
    super()
    this.serviceUUID = serviceUUID
    this.charUUID = charUUID

    this.discovered = new Map()

    this.central = new Central()
    this.central.on('discover', this._oncentraldiscover.bind(this))
    this.central.on('connect', this._oncentralconnect.bind(this))
    this.central.on('disconnect', this._oncentraldisconnect.bind(this))
    this.central.on('error', this.emit.bind(this, 'error'))

    this.scanning = false
    this._peripheral = null
  }

  _initServer() {}

  announce(id) {}

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

  _oncentraldiscover(peripheral) {
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

    if (!peer.key && !peer.ignore && !this._peripheral /* TODO: proper connect queue */) {
      this._connect(peripheral.id)
    }
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

    this._peripheral = peripheral
    this.central.connect(peripheral)
  }

  _oncentralconnect(peripheral) {
    console.log('connected:', peripheral.id, peripheral.name)

    const { id } = peripheral

    // TODO: idempotence
    const finish = (disconnect = false, ban = false, error = null) => {
      console.log('finish()', disconnect, ban, error)
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
      console.log('value hex:', Buffer.from(data).toString('hex'))
      console.log('value utf8:', Buffer.from(data).toString('utf8'))

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

    peripheral.discoverServices([SERVICE_UUID])
  }

  _oncentraldisconnect(peripheral) {
    console.log('_oncentraldisconnect()', peripheral.id)
    // TODO: move disconnectedAt = Date.now() here if signal stable.

    if (this._peripheral) {
      console.log('post cleanup', this._peripheral.id)
      this.central.disconnect(this._peripheral)
      this._peripheral = null
    }

    // TODO
    // this._resumeScan()
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
