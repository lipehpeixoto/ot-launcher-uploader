## About

Helper scripts for synchronizing client files with R2 bucket, using AWS S3.

## Requirements

- Node.js 20+

## Installation

1. Run `npm install`
2. Rename `.env.example` to `.env` and configure

## Usage

| Script   | Arguments   | Description                                                                                                  |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `upload` | None        | Uploads new files, use it when bucket is empty                                                               |
| `purge`  | `-y, --yes` | Deletes every file in the bucket                                                                             |
| `sync`   | None        | Deletes files from the bucket that are in manifest but not present locally, uploads any new or modified file |

> [!TIP]
> Use `npm run <script name>`
