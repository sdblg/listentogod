import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'

// Generate self-signed certificate if it doesn't exist
const certDir = path.join(import.meta.dirname, '.cert')
const certFile = path.join(certDir, 'cert.pem')
const keyFile = path.join(certDir, 'key.pem')

if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
  console.log('Generating self-signed certificate for HTTPS...')
  fs.mkdirSync(certDir, { recursive: true })
  require('child_process').execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile} -days 365 -nodes -subj "/CN=localhost"`,
    { stdio: 'inherit' }
  )
}

export default defineConfig({
  server: {
    port: 443,
    host: '0.0.0.0',
    https: {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile)
    }
  }
})
