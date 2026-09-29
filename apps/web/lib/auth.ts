'use client';
import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch, useApiQuery, useApiQueryClient, jsonInit } from '@/lib/api';

/**
 * 会话（M13-F1）
 *
 * 事实源：cookies 由 API 下发（agent_access / agent_refresh，见 apps/api/src/modules/auth/auth.constants.ts）；
 * 前端**不存任何 token**（无 localStorage），身份只能由 /api/v1/auth/me 获得。
 */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

export interface MeResponse { data: { user: CurrentUser } }

/** 会话查询键：全站唯一（AppShell / 各页面 / 失效调用必须复用，避免多份缓存） */
export const ME_QUERY_KEY = ['me'] as const;

/**
 * 当前用户。全局共享同一 queryKey → 全站只有一次 /auth/me 请求（staleTime 30s）。
 * `enabled:false` 用于公开路由（/login）避免无谓 401。
 */
export function useCurrentUser(options: { enabled?: boolean } = {}) {
  return useApiQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    path: '/api/v1/auth/me',
    enabled: options.enabled ?? true,
  });
}

/** 会话已失效（401/403）——页面据此跳登录页 */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'UNAUTHORIZED' || error.code === 'DEVICE_REVOKED');
}

export interface UseAuthActions {
  logout: () => Promise<void>;
  /** 清空缓存并跳登录页（logout 失败也照跳：cookie 可能已失效） */
  logoutAndRedirect: () => Promise<void>;
}

export function useAuthActions(): UseAuthActions {
  const router = useRouter();
  const queryClient = useApiQueryClient();

  const logout = useCallback(async () => {
    try { await apiFetch('/api/v1/auth/logout', jsonInit('POST')); } catch { /* 已失效也继续 */ }
    queryClient.clear();
  }, [queryClient]);

  const logoutAndRedirect = useCallback(async () => {
    await logout();
    router.replace('/login');
  }, [logout, router]);

  return { logout, logoutAndRedirect };
}
