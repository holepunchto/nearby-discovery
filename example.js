const NearbyPeers = require('.')

const service = new NearbyPeers()

service.on('discovered', peer => {
  console.log('peer resolved', peer)
})

service.on('error', console.error)
service.scan()
