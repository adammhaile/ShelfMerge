// Live-update test: edit a book's title directly on dev server A (as its root
// user), then expect ShelfMerge to (1) relay `item_updated` to a client socket
// twice, once with the source library id and once with the merged library id,
// and (2) serve the new title from the merged library's index.
import { io } from 'socket.io-client'

const SM = process.env.SM ?? 'http://localhost:3333'
const ABS_A = process.env.ABS_A ?? 'http://localhost:13378'
const json = (r) => r.json()
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json)

const login = await post(`${SM}/login`, { username: 'adam', password: 'adam' })
const token = login.user.accessToken
const auth = { authorization: `Bearer ${token}` }
const libs = await fetch(`${SM}/api/libraries`, { headers: auth }).then(json)
const merged = libs.libraries.find((l) => l.name === 'Everything')
const devA = libs.libraries.find((l) => l.name.startsWith('Dev A'))
const items = await fetch(`${SM}/api/libraries/${devA.id}/items?minified=1`, { headers: auth }).then(json)
const item = items.results.find((i) => i.media.metadata.title.startsWith('The Sequel'))

const root = await post(`${ABS_A}/login`, { username: 'root', password: 'rootpass' })
const rootAuth = { authorization: `Bearer ${root.user.accessToken}` }
const newTitle = `The Sequel ${Date.now() % 1000}`

const socket = io(SM, { transports: ['websocket'] })
const seen = []
const timeout = setTimeout(() => {
  console.error('FAIL: timed out; events seen:', seen)
  process.exit(1)
}, 15000)

socket.on('connect', () => socket.emit('auth', token))
socket.on('init', async () => {
  const r = await fetch(`${ABS_A}/api/items/${item.id}/media`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...rootAuth }, body: JSON.stringify({ metadata: { title: newTitle } }) })
  if (!r.ok) {
    console.error('FAIL: upstream edit returned', r.status)
    process.exit(1)
  }
})
socket.on('item_updated', async (li) => {
  if (li.id !== item.id) return
  seen.push(li.libraryId)
  if (seen.includes(devA.id) && seen.includes(merged.id)) {
    clearTimeout(timeout)
    await new Promise((r) => setTimeout(r, 300))
    const fromIndex = await fetch(`${SM}/api/libraries/${merged.id}/search?q=${encodeURIComponent(newTitle)}`, { headers: auth }).then(json)
    const found = fromIndex.book.some((b) => b.libraryItem.media.metadata.title === newTitle)
    // Restore the title so repeated runs stay clean.
    await fetch(`${ABS_A}/api/items/${item.id}/media`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...rootAuth }, body: JSON.stringify({ metadata: { title: 'The Sequel' } }) })
    socket.close()
    console.log('item_updated relayed with libraryIds:', seen.map((id) => (id === merged.id ? 'merged' : 'source')))
    console.log('merged index has new title:', found)
    console.log(found ? 'LIVE OK' : 'FAIL: index not updated')
    process.exit(found ? 0 : 1)
  }
})
