/**
 * Manage ShelfMerge user passwords without putting them in the config.
 *
 *   npm run user -- list                 users in the database
 *   npm run user -- passwd <name>        set a password (prompted); signs that user out everywhere
 *   npm run user -- hash                 print a bcrypt hash of a prompted password, for `password:` in the YAML
 *
 * In Docker: docker exec -it shelfmerge node dist/tools/user.js passwd <name>
 * Users must still be listed under `users:` in the config to be allowed to log in.
 */
import readline from 'node:readline'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../config.js'
import { openDb } from '../db.js'
import type { UserRow } from '../db.js'

let lines: string[] | null = null

/** Ask on a terminal without echoing; read a line from piped stdin otherwise. */
async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!lines) {
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
    }
    return lines.shift() ?? ''
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = process.stdout
    const write = out.write.bind(out)
    write(question)
    // Hide the typed password.
    out.write = ((chunk: string | Uint8Array) => (typeof chunk === 'string' && !/^\r?\n$/.test(chunk) ? true : write(chunk))) as typeof out.write
    rl.question('', (answer) => {
      out.write = write
      write('\n')
      rl.close()
      resolve(answer)
    })
  })
}

async function main() {
  const [cmd, name] = process.argv.slice(2)
  if (cmd === 'hash') {
    const pw = await prompt('Password: ')
    if (!pw) throw new Error('empty password')
    console.log(bcrypt.hashSync(pw, 10))
    return
  }
  const cfg = loadConfig(process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml')
  const db = openDb(cfg.dataDir)
  try {
    if (cmd === 'list') {
      const rows = db.prepare('SELECT username, passwordHash, createdAt, lastSeen FROM users ORDER BY username').all() as UserRow[]
      for (const r of rows) {
        const inConfig = cfg.users.some((u) => u.username === r.username)
        console.log(`${r.username.padEnd(20)} ${r.passwordHash ? 'password set' : 'NO PASSWORD '}  ${inConfig ? '' : '(not in config: cannot log in)'}  last seen ${r.lastSeen ? new Date(r.lastSeen).toISOString() : 'never'}`)
      }
      return
    }
    if (cmd === 'passwd' && name) {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name) as UserRow | undefined
      if (!user) throw new Error(`no user "${name}" in the database (add it to the config and start ShelfMerge once)`)
      const pw = await prompt(`New password for ${name}: `)
      const again = await prompt('Repeat: ')
      if (!pw || pw !== again) throw new Error('passwords empty or do not match')
      db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), user.id)
      db.prepare('DELETE FROM auth_sessions WHERE userId = ?').run(user.id)
      console.log(`Password for "${name}" updated; their sessions were signed out.`)
      return
    }
    console.error('usage: user list | user passwd <name> | user hash')
    process.exitCode = 2
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
