const NearbyPeers = require('.')

async function main() {
  const service = new NearbyPeers()

  const key = require('bare-crypto').randomBytes(32)

  console.log('key', key.toString('hex'))

  // init server
  await service.announce(key)
  console.log('listening')

  // scan client
  service.on('discovered', peer => {
    console.log('peer resolved', peer)
  })

  service.on('error', console.error)
  service.scan()
  console.log('scanning')
}

main()
