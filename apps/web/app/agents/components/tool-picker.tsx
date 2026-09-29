'use client';

import { AGENT_TOOL_CATALOG, groupedToolCatalog, isKnownTool } from '../tool-catalog';

/**
 * 工具多选（M13-W2）：勾选结果就是写入 `AgentVersion.tools` 的字符串数组。
 *
 * 关键点（防止静默丢数据）：`updateDraft` 是**整体替换** tools，所以这里必须把
 * 「该版本已选、但不在前端目录里」的工具原样呈现并保持勾选——扩展打包出来的工具（ext.*）
 * 不在 AGENT_TOOL_CATALOG 中，若被前端悄悄过滤掉，保存一次就等于把它们删了。
 */
export function ToolPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (name: string, checked: boolean) => void;
}) {
  const unknown = selected.filter((name) => !isKnownTool(name));
  const groups = [
    ...groupedToolCatalog(),
    ...(unknown.length > 0 ? [{ group: '未登记（来自扩展或其他来源）', tools: unknown.map((name) => ({ name, group: '' })) }] : []),
  ];

  if (AGENT_TOOL_CATALOG.length === 0 && unknown.length === 0) {
    return <p className="text-xs text-zinc-500">没有可选工具（后端工具注册表为空）。</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map(({ group, tools }) => (
        <div key={group}>
          <span className="mb-1 block text-xs text-zinc-500">{group}</span>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {tools.map((tool) => (
              <label key={tool.name} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900/60">
                <input
                  type="checkbox"
                  className="size-3.5 accent-zinc-400"
                  name="agent-tools"
                  value={tool.name}
                  checked={selected.includes(tool.name)}
                  onChange={(e) => onToggle(tool.name, e.target.checked)}
                />
                <span className="font-mono">{tool.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-zinc-600">
        工具清单为前端目录（后端无目录端点）；保存后由服务端工具注册表裁决实际可用子集。
      </p>
    </div>
  );
}
