import { NextFunction, Request, Response } from 'express';

/** CSRF 防护：非安全方法要求自定义头 X-Requested-With（跨站表单无法携带）；前端 apiFetch 统一附加。
 *  M7-P6 豁免：/hooks/ 公开 webhook 端点由 HMAC 签名鉴权（外部系统无 Cookie/X-Requested-With）。 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.includes('/hooks/')) return next();
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '非法请求来源' } });
    return;
  }
  next();
}
