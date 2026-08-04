const NearbyDiscovery = require('.')

async function main() {
  const service = new NearbyDiscovery()
  service.on('debug', console.info)
  service.on('error', console.error)

  const key = require('bare-crypto').randomBytes(32)

  console.log('local key', key.toString('hex'))

  // init server
  await service.announce(key)
  console.log('listening')

  // scan client
  service.on('discovered', (peer) => {
    console.log('peer resolved', peer)
  })

  service.discover()
  console.log('discovering')
}

main()
