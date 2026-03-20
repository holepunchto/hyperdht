const b4a = require('b4a')
const { PrefixHashTree } = require('prefix-hash-tree')
const { label } = require('prefix-hash-tree/node')
const createTestnet = require('../../testnet.js')

async function main() {
  const testnet = await createTestnet(20, { port: 49739 })

  // Introducing: Keyword Search (featuring Bob and Alice)

  const bob = testnet.nodes[0]
  const alice = testnet.nodes[1]

  // Bob precomputes a static trie topology over a finite vocabulary using a local datastore
  const localNodeTable = new AsyncMap()

  const localPHT = new PrefixHashTree({
    bitDomain: 80,
    getFunc: localNodeTable.get.bind(localNodeTable),
    putFunc: localNodeTable.put.bind(localNodeTable)
  })

  await localPHT.init()

  const coolVocab = ['dog', 'cat', 'bird', 'fish', 'tree', 'human', 'car', 'boat', 'plane', 'train']

  for (const keyword of coolVocab) {
    await localPHT.insert(localPHT.unhashedKeyFrom(keyword), `shard pointer for ${keyword}`)
  }

  const topologyID = b4a.from('coolVocab', 'utf8')
  
  // Bob stores the precomputed trie topology to the DHT, noting the indexID
  let indexID
  for (const [_, phtNode] of localNodeTable.map) {
    const { target, indexID: id, _ } =
      await bob.authenticatedPHTNodePut(bob.defaultKeyPair, topologyID, phtNode)
      indexID = id
  }

  console.log(`Bob created a keyword search index (ID ${indexID.toString('hex')})`)

  // (Bob shares the indexID with Alice...)

  // Now Alice can use that indexID to discover valid keywords
  const searchIndex = new PrefixHashTree({
    indexID: indexID.toString('hex'),
    bitDomain: 80,
    getFunc: async (target) => {
      const res = await alice.authenticatedPHTNodeGet(target)
      return res === null ? res : res.phtNode
    },
    putFunc: null
  })

  const query1 = await searchIndex.prefixQuery(searchIndex.prefixFrom('ca'))
  console.log(`Alice discovered keywords ${query1.map(([key, _]) => key).join(', ')}`)

  const query2 = await searchIndex.prefixQuery(searchIndex.prefixFrom('t'))
  console.log(`Alice discovered keywords ${query2.map(([key, _]) => key).join(', ')}`)

  // And Alice can add her document records under any valid keyword
  const catOnATrainRecord = b4a.from('cat_on_a_train.gif', 'utf8')
  const catOnAPlaneRecord = b4a.from('cat_on_a_plane.gif', 'utf8')

  const catKey = searchIndex.unhashedKeyFrom('cat')
  const catShard = await searchIndex.searchLeaf(catKey)
  const catTarget = searchIndex._labelHash(label(catShard))

  await alice.phtShardPut(catTarget, catKey, catOnATrainRecord)
  console.log(`Alice inserted ${catOnATrainRecord} under ${catKey}`)

  await alice.phtShardPut(catTarget, catKey, catOnAPlaneRecord)
  console.log(`Alice inserted ${catOnAPlaneRecord} under ${catKey}`)

  const trainKey = searchIndex.unhashedKeyFrom('train')
  const trainShard = await searchIndex.searchLeaf(trainKey)
  const trainTarget = searchIndex._labelHash(label(trainShard))

  await alice.phtShardPut(trainTarget, trainKey, catOnATrainRecord)
  console.log(`Alice inserted ${catOnATrainRecord} under ${trainKey}`)

  const planeKey = searchIndex.unhashedKeyFrom('plane')
  const planeShard = await searchIndex.searchLeaf(planeKey)
  const planeTarget = searchIndex._labelHash(label(planeShard))

  await alice.phtShardPut(planeTarget, planeKey, catOnAPlaneRecord)
  console.log(`Alice inserted ${catOnAPlaneRecord} under ${planeKey}`)

  // Later, Bob performs a search for "cat AND train"
  const bobSearchIndex = new PrefixHashTree({
    indexID: indexID.toString('hex'),
    bitDomain: 80,
    getFunc: async (target) => {
      const res = await bob.authenticatedPHTNodeGet(target)
      return res === null ? res : res.phtNode
    },
    putFunc: null
  })

  const bobCatKey = bobSearchIndex.unhashedKeyFrom('cat')
  const bobCatShard = await bobSearchIndex.searchLeaf(bobCatKey)
  const bobCatTarget = bobSearchIndex._labelHash(label(bobCatShard))

  const foundCatDocs =
    (await bob.phtShardGet(bobCatTarget, bobCatKey)).value.records.map(record => b4a.from(record).toString('utf8'))

  const bobPlaneKey = bobSearchIndex.unhashedKeyFrom('plane')
  const bobPlaneShard = await bobSearchIndex.searchLeaf(bobPlaneKey)
  const bobPlaneTarget = bobSearchIndex._labelHash(label(bobPlaneShard))

  const foundPlaneDocs =
    (await bob.phtShardGet(bobPlaneTarget, bobPlaneKey)).value.records.map(record => b4a.from(record).toString('utf8'))

  const intersection = [...new Set(foundCatDocs.filter(x => foundPlaneDocs.includes(x)))]

  console.log(`Bob searched '${bobCatKey} AND ${bobPlaneKey}' and found: ${intersection}`)
}

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

main()