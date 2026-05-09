import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

dotenv.config()

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.R2_REGION,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
})

const distDir = process.argv[2]
if (!distDir || !fs.existsSync(distDir)) {
  console.error('Usage: node upload-installer.js <launcher-dist-dir>')
  process.exit(1)
}

async function upload(localPath, key, contentType = 'application/octet-stream') {
  console.log(`  Uploading ${key} ...`)
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: contentType
  }))
}

const files = fs.readdirSync(distDir)
const installer = files.find(f => f.match(/Thornfeld-Setup-.*\.exe$/))
const blockmap = files.find(f => f.endsWith('.exe.blockmap'))
const latestYml = files.includes('latest.yml') ? 'latest.yml' : null

if (!installer) {
  console.error('No installer found in dist dir')
  process.exit(1)
}

const installerPath = path.join(distDir, installer)

// Website download link (generic name, no version)
await upload(installerPath, 'Thornfeld-Setup.exe')

// Auto-update files (electron-builder generic provider)
await upload(installerPath, `auto-updates/${installer}`)

if (latestYml) {
  await upload(path.join(distDir, latestYml), 'auto-updates/latest.yml', 'text/yaml')
}

if (blockmap) {
  await upload(path.join(distDir, blockmap), `auto-updates/${blockmap}`)
}

console.log('Installer upload complete.')
