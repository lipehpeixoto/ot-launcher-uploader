// Promote / rollback the stable update channel.
//
// The CDN has two manifests:
//   manifest.json        -- "latest": rewritten by every sync.js run
//                           (i.e. every push). Read by dev launchers.
//   manifest-stable.json -- "stable": read by packaged (player) launchers.
//                           Only changes when this script runs.
//
// Both point at the same immutable blobs/<md5> objects, so promotion and
// rollback are a single atomic JSON swap -- no file copying, no window of
// inconsistency, and any archived manifest stays valid forever.
//
// Usage:
//   node promote.js                  promote current manifest.json to stable
//   node promote.js --list           list archived stable manifests
//   node promote.js --restore NAME   re-promote an archived manifest
//                                    (NAME as printed by --list, with or
//                                    without the manifests/ prefix)
//
// Every promotion archives the outgoing stable manifest to
// manifests/stable-<timestamp>.json first, so --restore can always go back.

import dotenv from 'dotenv'
import axios from 'axios'
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

dotenv.config()

const MANIFEST_URL = process.env.R2_CDN_URL

const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.R2_REGION,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
})

async function fetchJson(name) {
    try {
        const response = await axios.get(`${MANIFEST_URL}/${name}`, {
            headers: { 'Cache-Control': 'no-cache' }
        })
        if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
            return null
        }
        return response.data
    } catch {
        return null
    }
}

async function putJson(key, data) {
    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: 'application/json'
    }))
}

// Same shape rules the launcher's Updater enforces before letting a
// manifest near the disk. A manifest that fails here must never become
// stable -- players' clean-pass would wipe their installs.
function sanityCheck(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return 'not a JSON object'
    }
    const keys = Object.keys(manifest)
    if (keys.length < 10) return `only ${keys.length} entries`
    if (!keys.some((k) => k.endsWith('.exe') && !k.startsWith('canary/'))) {
        return 'no client .exe entry'
    }
    if (!keys.some((k) => k.startsWith('canary/'))) {
        return 'no canary/ entries'
    }
    return null
}

async function archiveCurrentStable() {
    const current = await fetchJson('manifest-stable.json')
    if (!current) {
        console.log('No existing manifest-stable.json to archive (first promotion).')
        return
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const key = `manifests/stable-${ts}.json`
    await putJson(key, current)
    console.log(`Archived outgoing stable as ${key}`)
}

async function listArchives() {
    const result = await s3Client.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        Prefix: 'manifests/'
    }))
    const entries = (result.Contents || [])
        .map((o) => o.Key)
        .sort()
    if (entries.length === 0) {
        console.log('No archived manifests.')
        return
    }
    for (const key of entries) {
        console.log(key)
    }
}

async function promote(sourceName, label) {
    const manifest = await fetchJson(sourceName)
    if (!manifest) {
        console.error(`Failed to fetch ${sourceName} from CDN. Aborting.`)
        process.exit(1)
    }
    const problem = sanityCheck(manifest)
    if (problem) {
        console.error(`Sanity check failed for ${sourceName}: ${problem}. Aborting.`)
        process.exit(1)
    }
    await archiveCurrentStable()
    await putJson('manifest-stable.json', manifest)
    console.log(`Promoted ${label} to manifest-stable.json (${Object.keys(manifest).length} entries).`)
}

const args = process.argv.slice(2)

if (args[0] === '--list') {
    await listArchives()
} else if (args[0] === '--restore') {
    if (!args[1]) {
        console.error('Usage: node promote.js --restore <archive name from --list>')
        process.exit(1)
    }
    const name = args[1].startsWith('manifests/') ? args[1] : `manifests/${args[1]}`
    await promote(name, name)
} else if (args.length === 0) {
    await promote('manifest.json', 'latest manifest.json')
} else {
    console.error('Usage: node promote.js [--list | --restore <name>]')
    process.exit(1)
}
