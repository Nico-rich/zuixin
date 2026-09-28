import { Global, Module } from '@nestjs/common';
import { StorageAdapter } from './storage.types';
import { StorageLocalAdapter } from './local/storage-local.adapter';
import { StorageS3Adapter } from './s3/storage-s3.adapter';

/** 驱动名 → 规范化驱动（大小写/连字符容忍；`s3` 与 `s3-compatible` 同义，`minio` 是 MinIO 专用别名） */
const S3_ALIASES = new Set(['s3', 's3-compatible', 's3compatible', 'minio']);
const LOCAL_ALIASES = new Set(['local', 'fs', 'disk']);

/** 解析驱动名；未知值**不静默回退**（写错驱动名而对象落到本地磁盘是生产事故级静默降级） */
export function resolveStorageDriver(raw: string | undefined): 'local' | 's3' {
  const driver = (raw ?? 'local').trim().toLowerCase();
  if (S3_ALIASES.has(driver)) return 's3';
  if (LOCAL_ALIASES.has(driver)) return 'local';
  throw new Error(`未知 STORAGE_DRIVER: ${raw}（支持 ${[...LOCAL_ALIASES, ...S3_ALIASES].join(' / ')}）`);
}

@Global()
@Module({
  providers: [
    {
      provide: 'STORAGE_ADAPTER',
      useFactory: (): StorageAdapter => {
        if (resolveStorageDriver(process.env.STORAGE_DRIVER) === 's3') {
          return new StorageS3Adapter({
            endpoint: process.env.STORAGE_ENDPOINT ?? '',
            region: process.env.STORAGE_REGION ?? 'us-east-1',
            bucket: process.env.STORAGE_BUCKET ?? 'agent-storage',
            accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
            secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: true,
          });
        }
        return new StorageLocalAdapter(process.env.STORAGE_LOCAL_DIR ?? './data/storage');
      },
    },
  ],
  exports: ['STORAGE_ADAPTER'],
})
export class StorageModule {}
