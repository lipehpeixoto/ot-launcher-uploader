import dotenv from "dotenv";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import { progressBar } from 'progress-bar-cli'
import readline from 'readline';

dotenv.config();

const limit = pLimit(parseInt(process.env.UPLOAD_CONCURRENCY) || 5);

const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.R2_REGION,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

async function listAllObjects() {
    let continuationToken = undefined;
    const allObjects = [];

    do {
        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET,
            ContinuationToken: continuationToken
        });
        const response = await s3Client.send(command);

        if (response.Contents) {
            allObjects.push(...response.Contents.map((obj) => obj.Key));
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return allObjects;
}

async function deleteObject(key) {
    const command = new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
    await s3Client.send(command);
}

async function purgeBucket() {
    const allKeys = await listAllObjects();
    if (allKeys.length === 0) {
        console.log("Bucket is already empty.");
        return;
    }

    const start = new Date();
    let completed = 0;

    const tasks = allKeys.map((key) =>
        limit(async () => {
            try {
                await deleteObject(key);
                progressBar(++completed, allKeys.length, start)
            } catch (err) {
                console.error(`\nFailed to delete ${key}:`, err.message);
            }
        })
    );

    await Promise.all(tasks);
}

if (process.env.npm_config_yes) {
    await purgeBucket();
    console.log("\nPurge completed.");
    process.exit(0);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('This operation can NOT be undone. Are you sure you want to purge the bucket? (y/N) ', async (answer) => {
    answer = answer.toLowerCase()
    if (answer === 'y' || answer === 'yes') {
        await purgeBucket();
    } else {
        console.log('Purge cancelled.');
    }
    rl.close();

    console.log("\nPurge completed.");
});
