const express = require('express')
const {scrypt, timingSafeEqual} = require('node:crypto')
const {promisify} = require('node:util')
const jwt = require('./lib/util/jwtutil.js').default

const deriveKey = promisify(scrypt)
const {STF_ADMIN_NAME: name, STF_ADMIN_EMAIL: email, SECRET: secret, STF_LOCAL_PASSWORD_HASH: hash} = process.env
if (!name || !email || !secret || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash || '')) {
  throw new Error('Configure the local administrator, password hash and STF session secret')
}
const [salt, key] = hash.split(':').map(part => Buffer.from(part, 'hex'))
const origin = 'http://127.0.0.1:7100'
const app = express()
app.disable('x-powered-by')
app.use(express.urlencoded({extended: false, limit: '8kb'}))
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  next()
})

function signInPage(failed = false) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · DeviceFarmer</title>
<style>
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f3f5f7;color:#202831;font:16px system-ui,sans-serif}main{width:min(24rem,92vw);padding:2rem;background:white;border:1px solid #d7dde3;border-radius:.75rem}h1{font-size:1.45rem;margin:0 0 1.5rem}label{display:block;margin:1rem 0}input,button{font:inherit;width:100%;padding:.7rem;border-radius:.35rem}input{margin-top:.35rem;border:1px solid #929eab}button{background:#185f94;color:white;border:0;cursor:pointer}p{color:#a52222}
</style><main><h1>Sign in to DeviceFarmer</h1>${failed ? '<p role="alert">Incorrect username or password.</p>' : ''}
<form action="/auth/local/" method="post">
<label>Username<input name="username" autocomplete="username" required autofocus></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form></main></html>`
}

app.get('/auth/local/', (req, res) => res.send(signInPage()))
app.get('/auth/mock/', (req, res) => res.redirect('/auth/local/'))
app.post('/auth/local/', async (req, res) => {
  if (req.get('Origin') !== origin) return res.sendStatus(403)
  const {username, password} = req.body || {}
  if (typeof password !== 'string' || typeof username !== 'string') return res.sendStatus(400)
  const candidate = await deriveKey(password, salt, key.length)
  if (!timingSafeEqual(candidate, key) || username !== name) {
    return res.status(401).send(signInPage(true))
  }
  const token = jwt.encode({secret, payload: {email, name}, header: {exp: Date.now() + 60000}})
  res.set('Referrer-Policy', 'no-referrer')
  res.redirect(303, '/?jwt=' + encodeURIComponent(token))
})

app.listen(Number(process.env.PORT || 7100))
