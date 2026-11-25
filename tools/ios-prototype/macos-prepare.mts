import {execFileSync} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {iosDeviceId, parseIosConfig} from '../../lib/util/ios-config.ts'
import {renderIosCompose, renderIosNginx} from './compose-config.mts'

const repository = process.cwd()
const directory = path.join(repository, 'tmp/mac-ios')
const config = parseIosConfig(JSON.parse(fs.readFileSync('ios.local.json', 'utf8')))
if (config.publicOrigin !== 'http://127.0.0.1:7100') {
  throw new Error('Set publicOrigin to the local Mac dashboard at http://127.0.0.1:7100')
}
const base = JSON.parse(execFileSync('docker-compose', [
  '-f', 'docker-compose.yaml', '-f', 'docker/compose/macos.yaml', 'config', '--format', 'json'
], {encoding: 'utf8'}))
const {document, screenRoutes} = renderIosCompose(base, config, {
  repository, directory, stfImage: base.services.app.image, iosImage: 'stf-ios-runtime:local',
  socketPath: process.argv[2]
})
for (const device of config.devices) {
  const token = path.join(directory, iosDeviceId(device.udid) + '.token')
  if (!fs.existsSync(token)) {
    fs.writeFileSync(token, randomBytes(32).toString('hex') + '\n', {flag: 'wx', mode: 0o600})
  }
  fs.chmodSync(token, 0o644) // Readable by the container UID inside our private directory.
}
// Apply just the iOS services and Nginx routes to the existing Android stack.
const services = Object.fromEntries(Object.entries(document.services).filter(([k]) => k.startsWith('ios-')))
const volumes = Object.fromEntries(Object.entries(document.volumes || {}).filter(([k]) => k.startsWith('ios-')))
services.proxy = {volumes: document.services.proxy.volumes}
const nginx = renderIosNginx(fs.readFileSync('docker/compose/nginx.conf', 'utf8'), screenRoutes)
fs.writeFileSync(path.join(directory, 'nginx.conf'), nginx)
fs.writeFileSync(path.join(directory, 'compose.json'), JSON.stringify({services, volumes}, null, 2))
