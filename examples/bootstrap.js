const DHT = require('../')

const node = DHT.bootstrapper(49737)

node.ready().then(function () {
  console.log('Bootstrapper running on port ' + node.address().port)
})
