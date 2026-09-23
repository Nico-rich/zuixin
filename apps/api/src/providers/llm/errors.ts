import { AppError } from '../../common/errors/app-error';
import { mapProviderError, ProviderLikeError } from '../../common/errors/provider-error';

export { mapProviderError } from '../../common/errors/provider-error';
export type { ProviderLikeError } from '../../common/errors/provider-error';

export function toChatError(err: unknown, requestId?: string): AppError {
  if (err instanceof AppError) return err;
  const wrapped = mapProviderError(err as ProviderLikeError);
  return new AppError(wrapped.code, wrapped.message, requestId);
}
