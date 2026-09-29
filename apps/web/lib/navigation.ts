import {
  Activity, BarChart3, Blocks, Bot, Brain, CreditCard, FlaskConical, Gauge, LayoutDashboard,
  Library, MessagesSquare, Package, Plug, Puzzle, Settings, ShieldCheck, ShoppingCart, Sparkles, Store, Users, Workflow,
  type LucideIcon,
} from 'lucide-react';

/**
 * 全局导航注册表（M13-F1 契约文件）
 *
 * **这是页面 agents 的唯一注册点**：新增页面只需在 NAV_SECTIONS 里加一条 NavItem，
 * AppShell/GlobalSidebar 自动出现入口，无需改任何布局文件。
 *
 * 约定：
 *  - `href` 必须是 App Router 的真实路由（页面由 W2~W9 落地；本 wave 先提供入口）。
 *  - 激活判定默认前缀匹配且要求**路径分段边界**（`/agents` 不会命中 `/agent-runs`）。
 *  - 本文件不引入任何业务状态；图标一律来自既有依赖 lucide-react（不新增依赖）。
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** true = 仅路径完全相等时激活（用于 `/` 这类根路径） */
  exact?: boolean;
  /** 悬浮提示（如页面尚未落地时的说明）；不影响激活与渲染结构 */
  hint?: string;
}

export interface NavSection {
  id: string;
  /** 分组标题（视觉分隔；不作为 heading 元素渲染，避免影响页面标题层级断言） */
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'workspace',
    label: '工作区',
    items: [
      { href: '/', label: '首页', icon: LayoutDashboard, exact: true },
      { href: '/chat', label: '对话', icon: MessagesSquare },
      { href: '/workflows', label: '工作流', icon: Workflow },
      { href: '/approvals', label: '审批', icon: ShieldCheck },
      { href: '/evaluation', label: '评测', icon: FlaskConical },
      { href: '/marketplace', label: '扩展市场', icon: Store },
    ],
  },
  {
    id: 'capabilities',
    label: '能力',
    items: [
      { href: '/agents', label: 'Agents', icon: Bot },
      { href: '/agent-runs', label: 'Agent 运行', icon: Activity },
      { href: '/knowledge', label: '知识库', icon: Library },
      { href: '/memory', label: '记忆', icon: Brain },
      { href: '/creative', label: '创意工作台', icon: Sparkles },
      { href: '/artifacts', label: '制品', icon: Package },
    ],
  },
  {
    id: 'operations',
    label: '运营',
    items: [
      { href: '/connections', label: '连接', icon: Plug },
      { href: '/analytics', label: '分析', icon: BarChart3 },
      { href: '/ecommerce', label: '电商', icon: ShoppingCart },
      { href: '/feedback', label: '反馈', icon: Gauge },
      { href: '/usage', label: '用量', icon: Blocks },
      { href: '/billing', label: '账单', icon: CreditCard },
      { href: '/organizations', label: '组织团队', icon: Users },
    ],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { href: '/extensions', label: '扩展管理', icon: Puzzle },
      { href: '/settings', label: '设置', icon: Settings },
    ],
  },
];

/** 规范化路径：去掉查询串/结尾斜杠（根路径保留 `/`） */
export function normalizePath(pathname: string): string {
  const clean = (pathname.split(/[?#]/)[0] || '/').trim();
  if (clean === '' || clean === '/') return '/';
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

/** 单个导航项的激活判定（分段边界前缀匹配） */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const path = normalizePath(pathname);
  if (item.exact || item.href === '/') return path === normalizePath(item.href);
  const href = normalizePath(item.href);
  return path === href || path.startsWith(`${href}/`);
}

/** 扁平化后的全部导航项（需要枚举/测试时使用） */
export function allNavItems(): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items);
}
