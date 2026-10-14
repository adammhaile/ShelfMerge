const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof levels

const current: Level = ((process.env.LOG_LEVEL as Level) in levels ? process.env.LOG_LEVEL : 'info') as Level

function write(level: Level, args: unknown[]) {
  if (levels[level] < levels[current]) return
  const ts = new Date().toISOString()
  const line = `[${ts}] ${level.toUpperCase()}:`
  if (level === 'error') console.error(line, ...args)
  else console.log(line, ...args)
}

export const log = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a)
}
