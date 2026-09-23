import { Global, Module } from '@nestjs/common';
import { StorageAdapter } from './storage.types';
import { StorageLocalAdapter } from './local/storage-local.adapter';
import { StorageS3Adapter } from './s3/storage-s3.adapter';

@Global()
@Module({
  providers: [
    {
      provide: 'STORAGE_ADAPTER',
      useFactory: (): StorageAdapter => {
        const driver = process.env.STORAGE_DRIVER ?? 'local';
        if (driver === 's3-compatible') {
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
