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
    30,
    {
      port: 49739
    }
  )

  // Precompute a static trie topology using a local datastore
  const localNodeTable = new AsyncMap()

  const localPHT = new PrefixHashTree({
    bitDomain: 320,
    getFunc: localNodeTable.get.bind(localNodeTable),
    putFunc: localNodeTable.put.bind(localNodeTable)
  })

  await localPHT.init()

  const coolVocab = ['dog', 'cat', 'bird', 'fish', 'tree', 'human', 'car', 'boat', 'plane', 'train']

  for (const keyword of coolVocab) {
    await localPHT.insert(localPHT.unhashedKeyFrom(keyword), [`value for ${keyword}`])
  }

  const topologyID = b4a.from('coolVocab', 'utf8')
  
  // Store the precomputed topology the DHT, note the indexID
  let indexID
  for (const [_, phtNode] of localNodeTable.map) {
    const { target, indexID: id, _ } =
      await testnet.nodes[0].authenticatedPHTNodePut(testnet.nodes[0].defaultKeyPair, topologyID, phtNode)
      indexID = id
  }

  // Now anyone can use that indexID to search the DHT
  const searchIndex = new PrefixHashTree({
    indexID: indexID.toString('hex'),
    bitDomain: 320,
    getFunc: testnet.nodes[0].authenticatedPHTNodeGet.bind(testnet.nodes[0]),
    putFunc: null
  })

  const query = await searchIndex.prefixQuery(searchIndex.prefixFrom('ca'))
  console.log(`Discovered keywords ${query.map(([key, _]) => key)}`)

  const search = await searchIndex.searchExact(searchIndex.unhashedKeyFrom('car'))
  console.log(search)
}

main()