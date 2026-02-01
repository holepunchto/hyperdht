const test = require('brittle')
const { swarm } = require('./helpers')

const { SimHash } = require('simhash-vocabulary')
const { randomBytes } = require('hypercore-crypto')

test('search - disabled', async function (t) {
  const simhash = new SimHash(vocabulary)
  const { nodes } = await swarm(t, 100, [])

  // disabled
  t.is(nodes[30]._experimentalSearch, false)
  t.is(nodes[30]._persistent.searchableRecords, null)

  const pointer = randomBytes(32)

  await nodes[30].searchableRecordPut(simhash.hash(['planet', 'satellite']), pointer)

  const res = await nodes[30].search(simhash.hash(['planet', 'satellite']))
  t.is(res, undefined)
})

test('search - enabled', async function (t) {
  const simhash = new SimHash(vocabulary)
  const { nodes } = await swarm(t, 100, [], { experimentalSearch: true })

  // enabled
  t.is(nodes[30]._experimentalSearch, true)
  t.ok(nodes[30]._persistent.searchableRecords)

  const pointer = randomBytes(32)

  await nodes[30].searchableRecordPut(simhash.hash(['planet', 'satellite']), pointer)

  const res = await nodes[30].search(simhash.hash(['planet', 'satellite']))
  t.is(res.length, 1)
  t.is(res[0].values[0].toString('hex'), pointer.toString('hex'))
})

test('search - gc', async function (t) {
  const simhash = new SimHash(vocabulary)
  const { nodes } = await swarm(t, 100, [], {
    maxAge: 100, // give us some time to do a search
    experimentalSearch: true
  })

  const pointer = randomBytes(32)

  await nodes[30].searchableRecordPut(simhash.hash(['planet', 'satellite']), pointer)

  const res = await nodes[30].search(simhash.hash(['planet', 'satellite']))
  t.is(res.length, 1)
  t.is(res[0].values[0].toString('hex'), pointer.toString('hex'))

  await new Promise((res) => setTimeout(res, 250))

  // after gc
  {
    const res = await nodes[30].search(['planet', 'satellite'])
    t.is(res.length, 0)
  }
})

const vocabulary = [
  'apple',
  'table',
  'window',
  'pencil',
  'chair',
  'water',
  'book',
  'garden',
  'cloud',
  'bridge',
  'mountain',
  'river',
  'ocean',
  'forest',
  'stone',
  'mirror',
  'candle',
  'basket',
  'flower',
  'blanket',
  'pillow',
  'lamp',
  'carpet',
  'clock',
  'drawer',
  'kitchen',
  'ceiling',
  'hallway',
  'doorway',
  'staircase',
  'bedroom',
  'bathroom',
  'garage',
  'driveway',
  'sidewalk',
  'pavement',
  'street',
  'highway',
  'tunnel',
  'building',
  'tower',
  'castle',
  'temple',
  'statue',
  'fountain',
  'plaza',
  'market',
  'bakery',
  'grocery',
  'pharmacy',
  'library',
  'museum',
  'theater',
  'stadium',
  'airport',
  'station',
  'platform',
  'terminal',
  'vessel',
  'anchor',
  'harbor',
  'lighthouse',
  'island',
  'peninsula',
  'continent',
  'planet',
  'satellite',
  'telescope',
  'microscope',
  'thermometer',
  'compass',
  'calculator',
  'computer',
  'keyboard',
  'monitor',
  'printer',
  'scanner',
  'camera',
  'photograph',
  'painting',
  'sculpture',
  'drawing',
  'sketch',
  'canvas',
  'palette',
  'brush',
  'crayon',
  'marker',
  'eraser',
  'ruler',
  'notebook',
  'folder',
  'envelope',
  'package',
  'container',
  'bottle',
  'jar',
  'cup',
  'plate',
  'bowl',
  'spoon',
  'fork',
  'knife',
  'napkin',
  'tablecloth',
  'counter',
  'cabinet',
  'shelf',
  'closet',
  'wardrobe',
  'dresser',
  'nightstand',
  'sofa',
  'armchair',
  'cushion',
  'curtain',
  'blinds',
  'shutter',
  'rooftop',
  'chimney',
  'gutter',
  'fence',
  'gate',
  'pathway',
  'meadow',
  'valley',
  'hillside',
  'plateau',
  'canyon',
  'desert',
  'tundra',
  'glacier',
  'waterfall',
  'stream',
  'pond',
  'swamp',
  'marsh',
  'prairie',
  'woodland',
  'grove',
  'orchard',
  'vineyard',
  'farmland',
  'pasture',
  'barnyard',
  'stable',
  'henhouse',
  'silo',
  'tractor',
  'wagon',
  'barrel',
  'bucket',
  'rake',
  'hatchet',
  'hammer',
  'wrench',
  'screwdriver',
  'pliers',
  'toolbox',
  'workbench',
  'sawdust',
  'timber',
  'plank',
  'beam',
  'brick',
  'sand',
  'clay',
  'soil',
  'dust',
  'pebble',
  'boulder',
  'granite',
  'marble',
  'limestone',
  'quartz',
  'crystal',
  'diamond',
  'emerald',
  'sapphire',
  'ruby',
  'topaz',
  'amber',
  'pearl',
  'coral',
  'seashell',
  'starfish',
  'dolphin',
  'whale',
  'shark',
  'octopus',
  'jellyfish',
  'seahorse',
  'turtle',
  'penguin',
  'pelican',
  'seagull',
  'sparrow',
  'robin',
  'cardinal',
  'bluebird',
  'finch',
  'hummingbird',
  'butterfly',
  'dragonfly',
  'beetle',
  'grasshopper',
  'cricket',
  'firefly',
  'caterpillar',
  'ladybug',
  'spider',
  'squirrel',
  'rabbit',
  'chipmunk',
  'raccoon',
  'beaver',
  'otter',
  'hedgehog',
  'porcupine',
  'badger',
  'weasel',
  'mole',
  'gopher',
  'hamster',
  'gerbil',
  'guinea',
  'ferret',
  'parrot',
  'canary',
  'parakeet',
  'macaw',
  'cockatoo',
  'pigeon',
  'dove',
  'falcon',
  'eagle',
  'hawk',
  'owl',
  'vulture',
  'ostrich',
  'flamingo',
  'peacock',
  'pheasant',
  'quail',
  'turkey',
  'chicken',
  'rooster',
  'duckling',
  'gosling',
  'cygnet',
  'foal',
  'calf',
  'lamb',
  'piglet',
  'kitten',
  'puppy'
]

test.skip('search - big', async function (t) {
  const simhash = new SimHash(vocabulary)
  const { nodes } = await swarm(t, 2000, [], { experimentalSearch: true })

  const targetPointer = randomBytes(32)

  const target = generateDoc()
  await nodes[30].searchableRecordPut(simhash.hash(target), targetPointer)

  t.comment('creating docs')

  for (let i = 0; i < 10_000; i++) {
    const tokens = generateDoc()
    const pointer = randomBytes(32)
    await nodes[30].searchableRecordPut(simhash.hash(tokens), pointer)
  }

  t.pass('setup')

  const time = Date.now()
  const res = await nodes[30].search(simhash.hash(target), { closest: 10, values: 1 })

  t.ok(res.length, 5)

  t.is(res[0].values[0].toString('hex'), targetPointer.toString('hex'))
  t.comment('searched', Date.now() - time)
})

function generateDoc(tokenSize = 256) {
  const words = []
  for (let i = 0; i < tokenSize; i++) {
    words.push(vocabulary[Math.floor(Math.random() * vocabulary.length)])
  }

  return words
}
