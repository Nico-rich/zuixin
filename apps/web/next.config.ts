import type { NextConfig } from 'next';

// 注：不启用 output:'standalone'——Windows 下构建追踪创建 symlink 会 EPERM；
// 容器化部署时在 Linux 内构建再启用。
const nextConfig: NextConfig = {};
export default nextConfig;
