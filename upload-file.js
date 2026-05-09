// Generic single-file uploader for Cloudflare R2.
// Usage: node upload-file.js <localPath> <r2-key> [contentType]
//
// Used by deploy-client.sh to push the standalone-Wine zip
// (Thornfeld-Standalone.zip) alongside the launcher installer.

import dotenv from 'dotenv'
import fs from 'fs'
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

const localPath = process.argv[2]
const r2Key = process.argv[3]
const contentType = process.argv[4] || 'application/octet-stream'

if (!localPath || !r2Key) {
  console.error('Usage: node upload-file.js <localPath> <r2-key> [contentType]')
  process.exit(1)
}

if (!fs.existsSync(localPath)) {
  console.error('File not found:', localPath)
  process.exit(1)
}

const stat = fs.statSync(localPath)
const sizeMb = (stat.size / 1024 / 1024).toFixed(1)
console.log(`Uploading ${localPath} (${sizeMb} MB) -> ${r2Key} ...`)

await s3Client.send(new PutObjectCommand({
  Bucket: process.env.R2_BUCKET,
  Key: r2Key,
  Body: fs.createReadStream(localPath),
  ContentType: contentType
}))

console.log('Upload complete.')
