// Socket smoke test: authenticate like the web client, expect `init`, then
// trigger a progress update over HTTP and expect `user_item_progress_updated`.
import { io } from 'socket.io-client'

const SM = process.env.SM ?? 'http://localhost:3333'
const USER = process.env.SM_USER ?? 'adam'
const PASS = process.env.SM_PASS ?? 'adam'

const login = await fetch(`${SM}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) }).then((r) => r.json())
const token = login.user.accessToken
const auth = { authorization: `Bearer ${token}` }

const libs = await fetch(`${SM}/api/libraries`, { headers: auth }).then((r) => r.json())
const items = await fetch(`${SM}/api/libraries/${libs.libraries[0].id}/items?minified=1`, { headers: auth }).then((r) => r.json())
const item = items.results.find((i) => i.media.metadata.title === 'The Sequel')

const socket = io(SM, { transports: ['websocket'] })
const timeout = setTimeout(() => {
  console.error('FAIL: timed out waiting for socket events')
  process.exit(1)
}, 10000)

socket.on('connect', () => socket.emit('auth', token))
socket.on('auth_failed', (d) => {
  console.error('FAIL: auth_failed', d)
  process.exit(1)
})
socket.on('init', async (d) => {
  console.log('init:', d)
  await fetch(`${SM}/api/me/progress/${item.id}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ currentTime: 2, duration: 6, progress: 0.33 }) })
})
socket.on('user_updated', (u) => {
  const mp = u.mediaProgress.find((m) => m.libraryItemId === item.id)
  console.log('user_updated: progress for "The Sequel" =', mp?.currentTime)
  clearTimeout(timeout)
  socket.close()
  console.log('SOCKET OK')
  process.exit(0)
})
