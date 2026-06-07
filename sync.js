import dotenv from 'dotenv'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import pLimit from "p-limit";
import { progressBar } from 'progress-bar-cli'

dotenv.config()

const limit = pLimit(parseInt(process.env.UPLOAD_CONCURRENCY) || 5);

const DEFAULT_MANIFEST = {}
const MANIFEST_URL = process.env.R2_CDN_URL

const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.R2_REGION,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
})

async function fetchManifest() {
    try {
        const response = await axios.get(`${MANIFEST_URL}/manifest.json`, {
            headers: {
                'Cache-Control': 'no-cache'
            }
        })

        if (response.status !== 200 || !response.data) {
            return DEFAULT_MANIFEST
        }

        return response.data
    } catch {
        return DEFAULT_MANIFEST
    }
}

// Walk a source dir and produce a hash map keyed by `prefix + relativePath`.
// Client uses prefix "" (bare paths -- the format manifest has always used).
// Canary uses prefix "canary/" so the launcher's Updater can route those
// entries to the canary install dir on disk.
async function readSourceTree(root, prefix) {
    if (!root) return {}
    const rootAbs = path.resolve(root)
    if (!fs.existsSync(rootAbs)) return {}

    const files = fs.readdirSync(rootAbs, { withFileTypes: true, recursive: true })
    const localFiles = {}
    const hashLimit = pLimit(50)

    const tasks = files
        .filter((file) => file.isFile())
        .map((file) =>
            hashLimit(
                () =>
                    new Promise((resolve, reject) => {
                        const filePath = path.join(file.parentPath || file.path, file.name)
                        const relativeFilePath = path.relative(rootAbs, filePath).replace(/\\/g, '/')
                        const key = `${prefix}${relativeFilePath}`
                        const hash = crypto.createHash('md5')
                        const stream = fs.createReadStream(filePath)

                        stream.on('data', (data) => hash.update(data))
                        stream.on('end', () => {
                            localFiles[key] = {
                                size: fs.statSync(filePath).size,
                                hash: hash.digest('hex')
                            }
                            resolve()
                        })
                        stream.on('error', reject)
                    })
            )
        )

    await Promise.all(tasks)
    return localFiles
}

async function uploadFileToR2(localPath, remotePath, contentType = 'application/octet-stream') {
    const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: remotePath,
        Body: fs.createReadStream(localPath),
        ContentType: contentType
    })

    await s3Client.send(command)
}

const manifest = await fetchManifest()
if (Object.keys(manifest).length === 0) {
    console.log("Failed to fetch manifest or manifest is empty. Use \"npm run upload\" instead.")
    process.exit(1)
}

const localFiles = {
    ...(await readSourceTree(process.env.CLIENT_PATH, '')),
    ...(await readSourceTree(process.env.CANARY_PATH, 'canary/'))
}

// Resolve a manifest key back to its on-disk absolute path. Canary keys
// live under CANARY_PATH (strip the "canary/" prefix first); everything
// else lives under CLIENT_PATH.
const clientDir = process.env.CLIENT_PATH ? path.resolve(process.env.CLIENT_PATH) : null
const canaryDir = process.env.CANARY_PATH ? path.resolve(process.env.CANARY_PATH) : null
function resolveLocalPath(key) {
    if (key.startsWith('canary/')) {
        return path.join(canaryDir, key.slice('canary/'.length))
    }
    return path.join(clientDir, key)
}

// A given run only "manages" the namespaces it has a source tree for.
// A canary-only run (Action triggered by ot-canary push) MUST NOT
// delete client entries from R2 just because it can't see them locally
// -- they belong to a separate sync run that's not happening now.
function isManaged(key) {
    return key.startsWith('canary/') ? !!process.env.CANARY_PATH : !!process.env.CLIENT_PATH
}

let filesToDelete = []
for (const [filePath, _] of Object.entries(manifest)) {
    if (localFiles[filePath]) continue
    if (!isManaged(filePath)) continue
    filesToDelete.push(filePath)
}

const tasks = []
let completed = 0
let now = new Date()

for (const filePath of filesToDelete) {
    tasks.push(limit(async () => {
        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: filePath
        })
        await s3Client.send(command)
        progressBar(++completed, filesToDelete.length, now)
    }))
}

await Promise.all(tasks)

tasks.length = 0

let totalFiles = 0

for (const [filePath, fileInfo] of Object.entries(localFiles)) {
    const manifestFile = manifest[filePath]
    if (!manifestFile || manifestFile.hash !== fileInfo.hash) {
        totalFiles++
    }
}

completed = 0
now = new Date()

for (const [filePath, fileInfo] of Object.entries(localFiles)) {
    const absolutePath = resolveLocalPath(filePath)
    const manifestFile = manifest[filePath]
    if (!manifestFile || manifestFile.hash !== fileInfo.hash) {
        tasks.push(limit(async () => {
            await uploadFileToR2(absolutePath, filePath)
            try { progressBar(++completed, totalFiles, now) } catch(e) {}
        }))
    }
}

await Promise.all(tasks)

console.log(`\nUploaded ${totalFiles} file(s).`)

// New manifest = everything we just synced + foreign entries we kept
// alive (anything from the remote manifest we don't manage this run).
// Without this preservation step, a canary-only sync would wipe every
// client entry from the manifest and the launcher's clean-pass would
// then delete those files from every install.
const newManifest = { ...localFiles }
for (const [k, v] of Object.entries(manifest)) {
    if (!isManaged(k) && !newManifest[k]) {
        newManifest[k] = v
    }
}

fs.writeFileSync('manifest.json', JSON.stringify(newManifest))
await uploadFileToR2('manifest.json', 'manifest.json', 'application/json')
fs.unlinkSync('manifest.json')

console.log("Sync completed.")
