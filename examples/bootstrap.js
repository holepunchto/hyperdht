const DHT = require('../')

// You must use the public IP of the server where this bootstrap is running
const node = DHT.bootstrapper(49737, '127.0.0.1')

node.ready().then(function () {
  console.log('Bootstrapper running on port ' + node.address().port)
})
