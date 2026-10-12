/**
 * @local/dsh-tool-freeze —— 工具面冻结
 *
 * 问题：DeepSeek 的 Anthropic 兼容端点**不认 `tool_removal` 块**（实测 422
 * `unknown variant 'tool_removal'`），而顶层 `tools` 数组位于请求前缀的最前面
 * （提供方哈希顺序 `tools → system → messages`）。于是任何一次「工具变少」——
 * 卸载插件、禁用插件、热重载、工具管理器打勾——都会让缓存前缀从少掉的那一项
 * 起全部失效，长会话要重算整段历史（实测 desktop→rescue 首轮命中率 1.5%）。
 *
 * 做法：
 *  1. 挂在 `system-prompt/assemble` waterfall 上，把交付的工具声明补成
 *     「会话已声明的全集」——缺失项用**消失前的 schema 快照**、按**首次出现的位置**
 *     回插。这样 `header.tools` 与 `GenerateOptions.tools` 一起冻结，前缀逐字节不变。
 *     **完全不动工具注册表**，所以插件仍然可以自由装卸、热重载。
 *  2. 注册一条系统段落，声明「此刻真正可用的工具清单」+「已停用工具」。工具面变化时
 *     段落文本随之变化，DSH 的 in-history 机制会把它作为一条 system 角色快照
 *     追加到历史里（实测该机制命中率 0.985–0.988），于是"告知模型"本身不破前缀。
 *
 * ⚠️ 清单数据源踩过的四个坑（v0.1.3 修，见 README「实现注记」）：
 *   1. `ctx.tools.schemas(undefined)` —— 全局层视角，`read`/`write`/`pwsh`/`edit`
 *      等 agent/preset 作用域工具被整批误报"已停用"。
 *   2. `ctx.tools.schemas(context.scope)` —— desktop 上仍漏报 MCP 与 `tmpprofile_*`：
 *      assemble 的 tools 还含 `toolProviders` 的动态贡献，与注册表静态视图**不等价**。
 *   3. 用单个全局变量存"上一轮交付集" —— 进程里**多个装配作用域**都会触发本插件的
 *      handler，后写的覆盖先写的（主 agent 186 个工具被某小作用域的 68 个覆盖）。
 *   4. 用 `context.agent` 分桶 —— 拿到的键不保证是同一个对象，WeakMap 会 miss。
 *
 * 最终：**按 `context.scope` 分桶**（同一次装配内 handler 与 section 拿到的是同一个
 * context，故 scope 键可靠），且**只增不减**（同作用域会被以不同时机装配，MCP 注入
 * 是异步的，中间态工具集更小）。
 */

import { appendFileSync } from 'node:fs';

export const name = '@local/dsh-tool-freeze';

export const inject = ['tools', 'systemPrompt'];

const TAG = '[dsh-tool-freeze]';

function log(...args) {
  try {
    console.error(TAG, ...args);
  } catch {
    /* 观测不得影响宿主 */
  }
}

/** 段落顺序：落在用户/AGENTS 段（-900）之后、环境后缀段（10000+）之前。 */
const SECTION_ORDER = 9000;

export function apply(ctx, config = {}) {
  const freezeTools = config.freezeTools !== false;
  // ⚠️ 默认关闭：清单段目前**不可靠** —— 实测在 desktop 上，
  //    `system-prompt/assemble` 的 tools（61）≠ wire 上交付的 tools（186），
  //    因为该 waterfall 的 provider 链产物与 driver 实际组装用的来源不同。
  //    冻结（freezeTools）不受影响：wire 上确实冻结了（工具删减场景命中 92.4%）。
  //    等把 desktop 的装配路径查清、拿到可靠数据源之后再默认打开。
  const injectList = config.listSection === true;
  const verbose = config.verbose !== false;
  // 诊断日志：显式 config.debugFile 优先；否则默认写到 $DSH_HOME/tool-freeze-debug.log。
  // 内容按「作用域|live|restored|merged」去重，量很小；排查完可用 debugFile: '' 关掉。
  const home = process.env.DSH_HOME || `${process.env.USERPROFILE || process.env.HOME || '.'}/.dsh`;
  const debugFile =
    typeof config.debugFile === 'string' ? config.debugFile : `${home}/tool-freeze-debug.log`;

  /** name -> { schema, firstIndex }：本进程见过的全部工具（首次出现顺序）。 */
  const everSeen = new Map();
  let seq = 0;
  /** 装配作用域 -> 该作用域见过的最大工具名集合（只增不减）。 */
  const liveByScope = new WeakMap();
  /** 装配作用域 -> 最近一次被冻结补回的工具名。 */
  const restoredByScope = new WeakMap();
  /** 无作用域可归属时的兜底。 */
  let fallbackLive = [];
  let fallbackRestored = [];
  /** 作用域 -> 诊断序号。 */
  const scopeIds = new WeakMap();
  let scopeSeq = 0;
  const seenPairs = new Set();
  let lastLiveKey = '';

  const namesOf = (tools) =>
    Array.isArray(tools)
      ? tools.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean)
      : [];

  const sidOf = (scope) => {
    if (scope === undefined || scope === null) return 'none';
    let id = scopeIds.get(scope);
    if (id === undefined) {
      scopeSeq += 1;
      id = scopeSeq;
      scopeIds.set(scope, id);
    }
    return `S${id}`;
  };

  const dbg = (message) => {
    if (debugFile === '') return;
    try {
      appendFileSync(debugFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      /* 调试输出失败无所谓 */
    }
  };

  // ---- 1) 冻结交付的工具声明 -------------------------------------------
  ctx.effect(() => {
    let headerLogged = false;
    const handler = async (assembly, context, next) => {
      const result = await next();
      try {
        if (!result || !Array.isArray(result.tools)) return result;

        const liveNow = namesOf(result.tools);
        const scope = context?.scope;
        const sid = sidOf(scope);

        // 只增不减：同作用域会被以不同时机装配，中间态工具集更小，不能被覆盖
        const prevLive = (scope !== undefined && scope !== null ? liveByScope.get(scope) : undefined) ?? fallbackLive;
        if (liveNow.length >= prevLive.length) {
          if (scope !== undefined && scope !== null) liveByScope.set(scope, liveNow);
          else fallbackLive = liveNow;
        } else if (scope !== undefined && scope !== null && !liveByScope.has(scope)) {
          liveByScope.set(scope, prevLive);
        }

        const liveKey = [...liveNow].sort().join('\u0001');
        if (liveKey !== lastLiveKey) {
          lastLiveKey = liveKey;
          if (verbose) log(`live tools = ${liveNow.length} (scope ${sid})`);
        }

        for (const tool of result.tools) {
          if (!tool || typeof tool.name !== 'string') continue;
          const rec = everSeen.get(tool.name);
          if (rec === undefined) {
            everSeen.set(tool.name, { schema: tool, firstIndex: seq });
            seq += 1;
          } else {
            rec.schema = tool; // 保留"消失前最后一份"定义
          }
        }

        // 基线来源：会话已持久化的请求头（跨进程有效，正是"切实例/换装配"场景）
        const session = context?.agent?.session;
        let baselineTools = [];
        try {
          const header = session?.requestHeader?.();
          if (!headerLogged) {
            headerLogged = true;
            if (verbose) {
              log(
                `requestHeader: ${header === undefined ? 'undefined' : `keys=${Object.keys(header).join(',')} tools=${Array.isArray(header.tools) ? header.tools.length : 'n/a'}`}`,
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

        let mergedCount = '-';
        let restored = [];
        if (freezeTools && (baselineTools.length > 0 || everSeen.size > 0)) {
          const byName = new Map();
          for (const tool of result.tools) {
            if (tool && typeof tool.name === 'string') byName.set(tool.name, tool);
          }
          const merged = [];
          const seen = new Set();
          // ① 基线顺序优先：当前还活着的用当前定义，缺失的用基线/快照补回
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
          // ② 当前有、基线没有的（新增工具）追加到末尾
          for (const tool of result.tools) {
            if (!tool || typeof tool.name !== 'string' || seen.has(tool.name)) continue;
            seen.add(tool.name);
            merged.push(tool);
          }
          result.tools = merged;
          mergedCount = String(merged.length);
          if (verbose && restored.length > 0) log(`froze back ${restored.length} retired tool(s): ${restored.join(', ')}`);
        }

        if (scope !== undefined && scope !== null) restoredByScope.set(scope, restored);
        else fallbackRestored = restored;

        const key = `${sid}|${liveNow.length}|${restored.length}|${mergedCount}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          dbg(`assemble scope=${sid} live=${liveNow.length} restored=${restored.length} merged=${mergedCount} baseline=${baselineTools.length}`);
        }
      } catch (error) {
        log('freeze failed:', error?.message);
        dbg(`freeze failed: ${error?.message}`);
      }
      return result;
    };

    ctx.on('system-prompt/assemble', handler);
    if (verbose) log(`freeze hook installed (freezeTools=${freezeTools})`);
    if (debugFile !== '') dbg(`plugin installed freezeTools=${freezeTools} listSection=${injectList}`);
    return () => {
      /* ctx.on 的 disposer 由 effect 作用域回收 */
    };
  }, 'dsh-tool-freeze.freeze');

  // ---- 2) 追加「当前可用工具」系统段落 ---------------------------------
  if (injectList) {
    const renderList = (promptContext) => {
      const scope = promptContext?.scope;
      // 取"本作用域上一次装配"的结果：section 的求值早于 assemble waterfall，
      // 所以本轮真实清单尚不可得——差一轮，对"告知模型"这个用途可以接受。
      const live = ((scope !== undefined && scope !== null ? liveByScope.get(scope) : undefined) ?? fallbackLive) || [];
      const restored = ((scope !== undefined && scope !== null ? restoredByScope.get(scope) : undefined) ?? fallbackRestored) || [];
      const retiredSet = new Set(restored);
      const liveSorted = [...new Set(live)].filter((n) => !retiredSet.has(n)).sort();
      if (liveSorted.length === 0) return '';
      const retired = [...retiredSet].sort();

      if (verbose && lastRenderKey !== `${liveSorted.length}|${retired.length}`) {
        lastRenderKey = `${liveSorted.length}|${retired.length}`;
        log(`list rendered: live=${liveSorted.length} retired=${retired.length} (scope ${sidOf(scope)})`);
      }

      const lines = [
        '# 当前可用工具（唯一权威清单）',
        '',
        `此刻真正可用的工具共 **${liveSorted.length}** 个，只有以下这些可以调用：`,
        '',
        liveSorted.join(', '),
      ];
      if (retired.length > 0) {
        lines.push(
          '',
          '## 已停用工具',
          '',
          `以下工具虽然可能仍出现在工具声明里，但**当前已停用**，调用它们只会得到错误：${retired.join(', ')}`,
        );
      }
      return lines.join('\n');
    };
    let lastRenderKey = '';

    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: 'dsh-tool-freeze',
        order: SECTION_ORDER,
        text: renderList,
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
