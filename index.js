const FramedStream = require('framed-stream')
const { Central, Characteristic, Server, Service } = require('bare-bluetooth')
const EventEmitter = require('bare-events')

const SERVICE_UUID = 'B4A3C8A7-0000-1000-8000-00805F9B34FB'
const CHAR_KEY_UUID = 'B4A3C8A7-0004-1000-8000-00805F9B34FB' // key characteristic
const CHAR_STREAM_UUID = 'B4A3C8A7-0005-1000-8000-00805F9B34FB' // l2cap stream characteristic

const isAndroid = Bare.platform === 'android'
const scanOptions = isAndroid ? { scanMode: Central.SCAN_MODE_LOW_LATENCY } : undefined

module.exports = class NearbyPeers extends EventEmitter {
  constructor({
    useStream = false,
    serviceUUID = SERVICE_UUID,
    charUUID = CHAR_KEY_UUID,
    streamUUID = CHAR_STREAM_UUID
  } = {}) {
    super()
    this._localKey = null
    this._localName = null
    this.serviceUUID = serviceUUID
    this.charUUID = charUUID
    this.streamUUID = streamUUID

    this.central = new Central()
    this.central.on('discover', this._oncentraldiscover.bind(this))
    this.central.on('connect', this._oncentralconnect.bind(this))
    this.central.on('disconnect', this._oncentraldisconnect.bind(this))
    this.central.on('error', this.emit.bind(this, 'error'))

    this.discovered = new Map() // TODO: use 'xache', timeout: 0, size: 15
    this._scanTimeout = null
    this._flushTimeout = null
    this.discovering = false
    this._scanning = false
    this._connecting = false
    this._candidates = []

    this.announcing = false
    this.server = null
    this.chrKey = null
    this.chrStream = null
    this._psm = null
    this.localService = null
    this._useStream = useStream

    this._oncentralconnecterror = this._oncentralconnecterror.bind(this)
  }

  async _initServer() {
    this.server = new Server()
    this.server.on('readRequest', this._onreadrequest.bind(this))

    this.chrKey = new Characteristic(this.charUUID, { read: true })

    const chars = [this.chrKey]

    if (this._useStream) {
      this.chrStream = new Characteristic(this.streamUUID, { read: true })
      chars.push(this.chrStream)

      this.server.on('channelOpen', this._onchannelopen.bind(this))
    }

    await serverPowered(this.server)

    const serviceReady = serverServiceAdd(this.server)

    this.localService = new Service(this.serviceUUID, chars)
    this.server.addService(this.localService)

    await serviceReady

    if (this._useStream) {
      this._psm = await publishChannel(this.server)
      this.server.updateValue(this.chrStream, Buffer.from(String(this._psm))) // TODO: redundant?
    }

    this.server.on('error', this.emit.bind(this, 'error'))
    this.server.updateValue(this.chrKey, this._localKey) // TODO: redundant?
    this.server.startAdvertising({
      serviceUUIDs: [this.serviceUUID],
      name: this._localName
    })
  }

  async announce(id, { deviceName = 'keet-nearby' } = {}) {
    this._localName = deviceName
    this._localKey = id // TODO normalize to buffer < 512
    if (this.announcing) return

    this.announcing = true

    try {
      await this._initServer()
    } catch (err) {
      this.announcing = false
      throw err
    }
  }

  _onreadrequest(req) {
    console.log('_onreadrequest', req, req.offset)

    let value = null

    switch (normalizeUUID(req.characteristicUuid)) {
      case normalizeUUID(this.charUUID):
        if (req.offset > this._localKey.length) {
          this.server.respondToRequest(req, Server.ATT_UNLIKELY_ERROR)
        } else {
          const value = this._localKey.subarray(req.offset)
          this.server.respondToRequest(req, Server.ATT_SUCCESS, value)
        }
        break

      case normalizeUUID(this.streamUUID):
        value = this._psm === null ? Buffer.alloc(0) : Buffer.from(String(this._psm))
        this.server.respondToRequest(req, Server.ATT_SUCCESS, value)
        break

      default:
        this.server.respondToRequest(req, Server.ATT_INVALID_HANDLE)
    }
  }

  discover({ timeout = 0 } = {}) {
    this.discovering = true
    this._scan(timeout)
  }

  stopDiscover() {
    this.discovering = false
    this._stopScan()
  }

  _scan(timeout) {
    if (this._scanning) return
    this._scanning = true

    // power saving
    if (timeout > 0) {
      if (this._scanTimeout) clearTimeout(this._scanTimeout)
      this._scanTimeout = setTimeout(() => {
        console.info('scanTimeout: stopping scan')
        this._stopScan()
      }, timeout)
    }

    console.info('scan started')
    this.central.startScan([this.serviceUUID], scanOptions)
  }

  _stopScan() {
    if (!this._scanning) return

    if (this._scanTimeout) clearTimeout(this._scanTimeout)
    this._scanTimeout = null

    this._scanning = false

    try {
      this.central.stopScan()
    } catch (err) {
      // state mismatch in external system-service
      if (err.message !== 'No discovery started') {
        throw err
      }
    }

    console.info('scan stopped')
  }

  _oncentraldiscover(discoveredPeripheral) {
    const peripheral = discoveredPeripheral // todo

    const peer = {
      ...(this.discovered.get(peripheral.id) || spawnPeer()),

      // update radio props
      peripheral,
      address: peripheral.id,
      rssi: peripheral.rssi,
      deviceName: peripheral.name
    }

    peer.seenCount++
    peer.seenDate = Date.now()

    this.discovered.set(peripheral.id, peer)

    console.log('discovered:', peripheral.id, peripheral.name, peripheral.rssi)

    if (peer.key) return
    if (peer.ignore) return

    this._queueConnect(peripheral.id)
  }

  _queueConnect(id) {
    if (this._connecting) return

    this._candidates.push(id)

    if (this._flushTimeout) clearTimeout(this._flushTimeout)
    this._flushTimeout = setTimeout(
      this._flush.bind(this),
      2000 /* todo. halve after each discover. */
    )
  }

  _flush() {
    if (this._connecting) return

    if (this._flushTimeout) clearTimeout(this._flushTimeout)
    this._flushTimeout = null

    const candidates = this._candidates
    this._candidates = [] // expect fresh rssi on next _scan()

    // pick strongest signal
    candidates.sort((ida, idb) => {
      const a = this.discovered.get(ida)
      const b = this.discovered.get(idb)

      if (!a && !b) return 0
      if (!a) return 1
      if (!b) return -1

      const sa = a.rssi ?? -100
      const sb = b.rssi ?? -100

      return sb - sa
    })

    let id = null

    for (const candidate of candidates) {
      const peer = this.discovered.get(candidate)
      if (!peer) continue
      if (peer.key) continue
      if (peer.ignore) continue

      id = candidate
      break
    }

    if (id) {
      this._connect(id)
    } else if (this.discovering) {
      this._scan(/* TODO missing reduced timeout */)
    }
  }

  _connect(id) {
    const peer = this.discovered.get(id)
    if (!peer) throw new Error('unknown peer')

    const { peripheral } = peer
    if (!peripheral) throw new Error('unknown peripheral')

    if (this._connecting) throw new Error('unreachable')
    this._connecting = true

    try {
      this._stopScan()
    } catch (err) {
      this._oncentralconnecterror(err)
      return
    }

    peer.connectedAt = Date.now()
    peer.attempts++
    console.log('connect:', peripheral.id)

    this.central.once('error', this._oncentralconnecterror)
    this.central.connect(peripheral)
  }

  _oncentralconnecterror(err) {
    console.log('Central.connect() failed:', err)
    this._connecting = false
    if (this.discovering) this._scan() // resume
  }

  _oncentralconnect(peripheral) {
    console.log('connected:', peripheral.id, peripheral.name)
    this.central.off('error', this._oncentralconnecterror)

    const { id } = peripheral

    let finished = false

    const finish = (disconnect = false, ban = false, error = null) => {
      console.log('finish()', finished, disconnect, ban, error)

      if (finished) return
      finished = true

      this._connecting = false

      const peer = this.discovered.get(id)
      peer.ignore ||= ban
      peer.error = error

      // ignore after 3 failed attempts
      // if (peer.key && peer.attempts > 3) peer.ignore = true

      if (disconnect) this.central.disconnect(peripheral)

      peripheral.destroy()

      if (this.discovering) {
        this._scan() // resume
      }
    }

    peripheral.on('servicesDiscover', (services) => {
      console.log('servicesDiscover:', services.map((service) => service.uuid).join(', '))

      if (!services?.length) return // TODO: bug bare-bluetooth/lib/linux.js

      for (const service of services) {
        if (sameUUID(service.uuid, this.serviceUUID)) {
          const filter = [this.charUUID]
          if (this._useStream) filter.push(this.streamUUID)

          peripheral.discoverCharacteristics(service, filter)
          return
        }
      }

      console.error('service not found:', this.serviceUUID)
      finish(true, true, 'characteristic not found')
    })

    peripheral.on('characteristicsDiscover', (service, characteristics) => {
      console.log('characteristicsDiscover:', characteristics.map((char) => char.uuid).join(', '))

      if (!characteristics?.length) return // TODO: bug bare-bluetooth/lib/linux.js

      let idChar = null
      let streamChar = null
      for (const characteristic of characteristics) {
        switch (normalizeUUID(characteristic.uuid)) {
          case normalizeUUID(this.charUUID):
            idChar = characteristic
            break

          case normalizeUUID(this.streamUUID):
            streamChar = characteristic
            break
        }
      }

      if (this._useStream && streamChar) {
        peripheral.read(streamChar)
      } else if (idChar) {
        peripheral.read(idChar)
      } else {
        console.error('characteristic not found:', this.charUUID)
        finish(true, true, 'characteristic not found')
      }
    })

    peripheral.on('read', (characteristic, data) => {
      if (sameUUID(characteristic.uuid, this.charUUID)) {
        console.log('read:', characteristic.uuid)
        console.log('key', Buffer.from(data).toString('hex'))

        const peer = this.discovered.get(id)
        peer.key = data

        finish(true)
        this.emit('discovered', peer)
      } else if (sameUUID(characteristic.uuid, this.streamUUID)) {
        const psm = parseInt(Buffer.from(data).toString('utf8'))
        // TODO: deny duplicate streams
        peripheral.openL2CAPChannel(psm)
      }
    })

    peripheral.on('channelOpen', (channel) => {
      console.info('_onchannelopen (outgoing)')
      const stream = new FramedStream(channel)

      // TODO: blocks further discovery/connects.
      stream.on('close', () => finish(true))

      this.emit('stream', stream, { initiator: true, channel, address: peripheral.id })
    })

    peripheral.on('disconnect', () => {
      console.log('peripheral disconnect')
      this.discovered.get(id).disconnectedAt = Date.now()

      finish(null) // TODO: determine behavior across platforms
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
    this._connecting = false
  }

  _onchannelopen(channel) {
    console.info('_onchannelopen (incoming)')
    const stream = new FramedStream(channel)
    // TODO: deny duplicate streams
    // either deduce remote BLE-addr from channel
    // or require a handshake.
    this.emit('stream', stream, { initiator: false, channel, address: null })
  }

  destroy() {
    if (this._scanTimeout) clearTimeout(this._scanTimeout)
    if (this._flushTimeout) clearTimeout(this._flushTimeout)
    if (this.server) this.server.destroy()
    this.central.destroy()
    // TODO: destroy open peripherals?
  }

  [Symbol.dispose]() {
    this.destroy()
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
    address: null,
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

async function serverPowered(server) {
  if (server.state === 'poweredOn') return

  return new Promise((resolve, reject) => {
    if (server.state === 'poweredOn') return resolve()

    function onstate(state) {
      console.log('server state', state)
      if (state === 'poweredOn') {
        server.off('stateChange', onstate)
        server.off('error', onerror)
        resolve()
      }
    }

    function onerror(error) {
      server.off('stateChange', onstate)
      reject(error)
    }

    server.once('error', onerror)
    server.on('stateChange', onstate)
  })
}

async function serverServiceAdd(server) {
  return new Promise((resolve, reject) => {
    function onserviceadd() {
      console.log('serviceAdd')

      server.off('error', onerror)
      resolve()
    }

    function onerror(error) {
      server.off('serviceAdd', onserviceadd)
      reject(error)
    }

    server.once('error', onerror)
    server.once('serviceAdd', onserviceadd)
  })
}

async function publishChannel(server) {
  return new Promise((resolve, reject) => {
    function onchannelpublish(psm) {
      console.info('channel published, psm:', psm)

      server.off('error', onerror)
      resolve(psm)
    }

    function onerror(err) {
      server.off('channelPublish', onchannelpublish)
      reject(err)
    }

    server.once('error', onerror)
    server.once('channelPublish', onchannelpublish)
    server.publishChannel()
  })
}
