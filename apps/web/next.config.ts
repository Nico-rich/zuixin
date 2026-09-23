import type { NextConfig } from 'next';

// 注：不启用 output:'standalone'——Windows 下构建追踪创建 symlink 会 EPERM；容器化部署时在 Linux 内构建再启用。
// /api 代理到后端：附件等 <img> 标签请求走同源，自动携带鉴权 cookie（生产由 nginx 同域名反代，架构文档 §12.1）
const nextConfig: NextConfig = {
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
};
export default nextConfig;
