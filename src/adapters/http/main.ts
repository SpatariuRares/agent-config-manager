// Starts the panel on localhost: `npm start` (or `node src/adapters/http/main.ts [--port 4321] [--no-open]`).
// Needs only Node 23.6+; no Orca, no agent. Listens on 127.0.0.1 alone, with a fresh token per run.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { nodeCommandRunner } from '../claude-cli.ts'
import { nodeFileSystem } from '../node-fs.ts'
import { fetchHttp } from '../updates.ts'
import { createConfigServer } from './server.ts'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = portArg === -1 ? 4321 : Number(args[portArg + 1])
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Usage: npm start -- [--port <number>] [--no-open]')
  process.exit(2)
}

const token = randomBytes(24).toString('base64url')
const server = createConfigServer({
  deps: { fs: nodeFileSystem, exec: nodeCommandRunner(), home: homedir(), http: fetchHttp() },
  panelDir: join(import.meta.dirname, '..', '..', '..', 'panel'),
  token
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: npm start -- --port ${port + 1}` : String(error))
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address() as { port: number }
  // The token rides in the fragment: browsers never send it to servers, logs or Referer headers.
  const url = `http://127.0.0.1:${bound}/#token=${token}`
  console.log(`Claude Config Manager is running at\n  ${url}\nKeep this terminal open; Ctrl-C stops it.`)
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    execFile(opener, [url], () => {})
  }
})
