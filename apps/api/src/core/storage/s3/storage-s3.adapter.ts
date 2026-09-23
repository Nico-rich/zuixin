import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { StorageAdapter } from '../storage.types';

export interface S3Config {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
}

/** S3 兼容驱动（MinIO / Cloudflare R2 / AWS S3 一套） */
export class StorageS3Adapter implements StorageAdapter {
  private readonly client: S3Client;
  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, stream: Readable, meta: { contentType: string; sizeBytes: number }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: stream,
      ContentType: meta.contentType, ContentLength: meta.sizeBytes,
    }));
  }

  async createPresignedUrl(key: string, expiresInSec: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: expiresInSec });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
