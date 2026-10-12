/**
 * @local/dsh-tool-freeze —— 工具面冻结 + 工具可用性清单
 *
 * 问题：DeepSeek 的 Anthropic 兼容端点不认 `tool_removal` 块（实测 422），而顶层
 * `tools` 位于请求前缀最前面（hash 顺序 tools → system → messages）。工具一少，
 * 缓存从那一项起全断（实测 desktop→rescue 首轮只命中 1.5%）。
 *
 * 两条机制：
 *  1) **冻结**：在 `system-prompt/assemble` waterfall 里把交付的 tools 补成
 *     「会话已声明的全集」——缺失项用快照、按首见位置回插。基线取
 *     `agent.session.requestHeader().tools`（跨进程/跨实例有效）。不碰注册表。
 *  2) **可用性清单**：冻结的代价是声明里留着已停用的工具名，模型会照着调
 *     （实测 rescue 会话 10 次调用中 9 次报 `unknown tool`）。所以在段落里声明
 *     「哪些是真的、哪些已停用」。
 *
 * ⚡ 清单的时序坑（v0.1.6 修）：`dsh-system-prompt` **先渲染 sections、再发
 *    assemble waterfall**，所以段落 text() 求值时拿不到本轮 tools，写出来的清单
 *    天生**慢一轮**。解法：在同一个 waterfall 里拿到 `result.tools`（本轮真实）
 *    后，**直接重写自己那段 section 的 text** —— 零延迟，且仍走 in-history
 *    追加，不破前缀。段落的 text() 保留为兜底（万一 waterfall 未覆盖到）。
 */

import { appendFileSync } from 'node:fs';

export const name = '@local/dsh-tool-freeze';

export const inject = ['tools', 'systemPrompt'];

const TAG = '[dsh-tool-freeze]';
const SECTION_NAME = 'dsh-tool-freeze';
/** 段落顺序：落在用户/AGENTS 段（-900）之后、环境后缀段（10000+）之前。 */
const SECTION_ORDER = 9000;

function log(...args) {
  try {
    console.error(TAG, ...args);
  } catch {
    /* 观测不得影响宿主 */
  }
}

function namesOf(tools) {
  return Array.isArray(tools)
    ? tools.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean)
    : [];
}

/** 清单文本：给定「本轮真实可用」与「本轮被补回的（已停用）」，渲染成段落。 */
function renderListText(liveNames, restoredNames) {
  const retiredSet = new Set(restoredNames);
  const live = [...new Set(liveNames)].filter((n) => !retiredSet.has(n)).sort();
  const retired = [...retiredSet].sort();
  if (live.length === 0 && retired.length === 0) return '';

  const lines = [
    '# 工具可用性状态（重要：与当前工具面同步）',
    '',
    '> 为保持会话的 KV 缓存前缀稳定，本会话的**工具声明会保留已经停用的工具名**。',
    '> 所以「出现在工具声明里」**不等于**「现在能用」——以下才是当前真实状态。',
    '',
  ];
  if (retired.length > 0) {
    lines.push(
      `## ⛔ 已停用（共 ${retired.length} 个）——调用它们会直接失败（unknown tool），不要调用`,
      '',
      retired.join(', '),
      '',
    );
  }
  lines.push(
    `## ✅ 当前真实可用（共 ${live.length} 个）`,
    '',
    live.join(', '),
    '',
    '（运行期动态追加的工具——例如 MCP——不在上表范围内，它们本来就准确可见，照常用。）',
  );
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const freezeTools = config.freezeTools !== false;
  const injectList = config.listSection !== false;
  const verbose = config.verbose !== false;
  const home = process.env.DSH_HOME || `${process.env.USERPROFILE || process.env.HOME || '.'}/.dsh`;
  const debugFile =
    typeof config.debugFile === 'string' ? config.debugFile : `${home}/tool-freeze-debug.log`;

  /** name -> { schema }: 本进程见过的全部工具（含消失前最后一份定义）。 */
  const everSeen = new Map();
  /** 装配作用域 -> 该作用域见过的最大工具名集合（防中间态小集合覆盖）。 */
  const liveByScope = new WeakMap();
  let fallbackLive = [];
  let fallbackRestored = [];
  /** 上一次清单渲染的指纹（差一轮的兜底路径用）。 */
  let lastListKey = '';
  const seenPairs = new Set();

  const dbg = (message) => {
    if (debugFile === '') return;
    try {
      appendFileSync(debugFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      /* 调试输出失败无所谓 */
    }
  };

  ctx.effect(() => {
    let headerLogged = false;
    const handler = async (assembly, context, next) => {
      const result = await next();
      try {
        if (!result || !Array.isArray(result.tools)) return result;

        const liveNow = namesOf(result.tools);
        const scope = context?.scope;

        // 只增不减：同作用域会被以不同时机装配，中间态工具集更小
        const prevLive = (scope != null ? liveByScope.get(scope) : undefined) ?? fallbackLive;
        if (liveNow.length >= prevLive.length) {
          if (scope != null) liveByScope.set(scope, liveNow);
          else fallbackLive = liveNow;
        }

        for (const tool of result.tools) {
          if (!tool || typeof tool.name !== 'string') continue;
          const rec = everSeen.get(tool.name);
          if (rec === undefined) everSeen.set(tool.name, { schema: tool });
          else rec.schema = tool;
        }

        // 基线：会话已持久化的请求头（跨进程有效）
        const session = context?.agent?.session;
        let baselineTools = [];
        try {
          const header = session?.requestHeader?.();
          if (!headerLogged) {
            headerLogged = true;
            if (verbose) {
              log(
                `requestHeader: ${header === undefined ? 'undefined' : `tools=${Array.isArray(header.tools) ? header.tools.length : 'n/a'}`}`,
              );
            }
          }
          if (Array.isArray(header?.tools)) baselineTools = header.tools;
        } catch (error) {
          if (!headerLogged) {
            headerLogged = true;
            log('requestHeader() threw:', error?.message);
          }
        }

        let restored = [];
        if (freezeTools && (baselineTools.length > 0 || everSeen.size > 0)) {
          const byName = new Map();
          for (const tool of result.tools) {
            if (tool && typeof tool.name === 'string') byName.set(tool.name, tool);
          }
          const merged = [];
          const seen = new Set();
          for (const base of baselineTools) {
            if (!base || typeof base.name !== 'string' || seen.has(base.name)) continue;
            seen.add(base.name);
            const liveTool = byName.get(base.name);
            if (liveTool !== undefined) merged.push(liveTool);
            else {
              merged.push(everSeen.get(base.name)?.schema ?? base);
              restored.push(base.name);
            }
          }
          for (const tool of result.tools) {
            if (!tool || typeof tool.name !== 'string' || seen.has(tool.name)) continue;
            seen.add(tool.name);
            merged.push(tool);
          }
          result.tools = merged;
          if (verbose && restored.length > 0) log(`froze back ${restored.length} retired tool(s)`);
        }

        if (scope != null) fallbackRestored = restored;
        else fallbackRestored = restored;
        if (scope != null) liveByScope.set(scope, liveByScope.get(scope) ?? liveNow);

        // ⚡ 零延迟清单：section 的 text() 早于本 waterfall 求值，这里用**本轮**真实
        //    数据把段落文本重写掉。仍走 in-history 追加，不破前缀。
        if (injectList && Array.isArray(result.sections)) {
          const mine = result.sections.find((s) => s && s.name === SECTION_NAME);
          if (mine !== undefined) {
            const text = renderListText(liveNow, restored);
            if (typeof mine.text === 'string' && mine.text !== text) mine.text = text;
            else if (mine.text === undefined) mine.text = text;
          }
        }

        const key = `${liveNow.length}|${restored.length}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          dbg(`assemble live=${liveNow.length} restored=${restored.length} baseline=${baselineTools.length}`);
        }
      } catch (error) {
        log('freeze failed:', error?.message);
        dbg(`freeze failed: ${error?.message}`);
      }
      return result;
    };

    ctx.on('system-prompt/assemble', handler);
    if (verbose) log(`freeze hook installed (freezeTools=${freezeTools}, listSection=${injectList})`);
    dbg(`plugin installed freezeTools=${freezeTools} listSection=${injectList}`);
    return () => {
      /* disposer 由 effect 作用域回收 */
    };
  }, 'dsh-tool-freeze.freeze');

  // 兜底段落：正常情况下会被上面的 handler 每轮重写成本轮真实数据。
  if (injectList) {
    const fallbackText = () => {
      const live = fallbackLive;
      const text = renderListText(live, fallbackRestored);
      if (verbose && lastListKey !== `${live.length}|${fallbackRestored.length}`) {
        lastListKey = `${live.length}|${fallbackRestored.length}`;
        log(`list fallback rendered: live=${live.length} retired=${fallbackRestored.length}`);
      }
      return text;
    };

    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: fallbackText,
      });
      if (verbose) log(`list section installed (order=${SECTION_ORDER})`);
      return () => {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      };
    }, 'dsh-tool-freeze.list');
  }
}
