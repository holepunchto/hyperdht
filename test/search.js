const test = require('brittle')
const { swarm } = require('./helpers')

const { SimHash } = require('@holepunchto/simhash')
const { randomBytes } = require('hypercore-crypto')

test('search', async function (t) {
  const { nodes } = await swarm(t, 100)

  for (const n of nodes) {
    n._simhash = new SimHash(vocabulary)
  }

  const pointer = randomBytes(32)

  await nodes[30].searchableRecordPut(['planet', 'satellite'], pointer)

  await new Promise((res) => setTimeout(res, 1000))

  const res = await nodes[30].search(['planet', 'satellite'])
  t.is(res.length, 1)
  t.is(res[0].values[0].toString('hex'), pointer.toString('hex'))
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

test.configure({ timeout: 60_000 })

test('search - big', async function (t) {
  const { nodes } = await swarm(t, 2000)

  const targetPointer = randomBytes(32)

  for (const n of nodes) {
    n._simhash = new SimHash(vocabulary)
  }

  const target = generateDoc()
  await nodes[30].searchableRecordPut(target, targetPointer)

  t.comment('creating docs')

  for (let i = 0; i < 10_000; i++) {
    const tokens = generateDoc()
    const pointer = randomBytes(32)
    await nodes[30].searchableRecordPut(tokens, pointer)
  }

  t.pass('setup')

  const time = Date.now()
  const res = await nodes[30].search(target, { closest: 10, values: 1 })

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
