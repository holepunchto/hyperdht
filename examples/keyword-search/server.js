const b4a = require('b4a')
const { PrefixHashTree } = require('prefix-hash-tree')
const createTestnet = require('../../testnet.js')

class AsyncMap {
  constructor() {
    this.map = new Map()
  }

  async get(key) {
    return new Promise((resolve) => {
      resolve(this.map.get(key.toString('hex')) || null)
    })
  }

  async put(key, val) {
    return new Promise((resolve) => {
      this.map.set(key.toString('hex'), val)
      resolve(val)
    })
  }
}

async function main() {
  const testnet = await createTestnet(
    10,
    {
      port: 49739
    }
  )

  const precompute = new AsyncMap()

  const localPHT = new PrefixHashTree({
    bitDomain: 320,
    getFunc: precompute.get.bind(precompute),
    putFunc: precompute.put.bind(precompute)
  })

  await localPHT.init()

  const vocab = ['dog', 'cat', 'bird', 'fish', 'tree', 'human', 'car', 'boat', 'plane', 'train']

  for (const keyword of vocab) {
    await localPHT.insert(localPHT.unhashedKeyFrom(keyword), null)
  }

  const topologyID = b4a.from('myCoolTopology', 'utf8')

  for (const [_, phtNode] of precompute.map) {
    await testnet.nodes[0].authenticatedPHTNodePut(testnet.nodes[0].defaultKeyPair, topologyID, phtNode)
  }
}

main()