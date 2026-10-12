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
 *     「本进程见过的全集」——缺失项用**消失前的 schema 快照**、按**首次出现的位置**
 *     回插。这样 `header.tools` 与 `GenerateOptions.tools` 一起冻结，前缀逐字节不变。
 *     **完全不动工具注册表**，所以插件仍然可以自由装卸、热重载。
 *  2. 注册一条系统段落，声明「此刻真正可用的工具清单」+「已停用工具」。工具面变化时
 *     段落文本随之变化，DSH 的 in-history 机制会把它作为一条 system 角色快照
 *     追加到历史里（实测该机制命中率 0.985–0.988），于是"告知模型"本身不破前缀。
 *
 * ⚠️ 两处踩过的坑（v0.1.1 修，详见 README「实现注记」）：
 *   - **不能用 `ctx.tools.schemas(undefined)` 当"真实可用"**：那是全局层视角，
 *     看不到 agent / preset 作用域注册的工具。`read` / `write` / `pwsh` / `edit`
 *     等基础工具正是这一类，用全局视角会把它们整批误报成"已停用"。
 *   - **清单段的求值早于本插件的 assemble handler**（`dsh-system-prompt` 先求值
 *     sections、再发 waterfall），且 `tools` 是同一个 agent 视角算出来的。所以
 *     "真实可用"必须**按 agent 分别记录**，否则会被别的 agent（如标题生成）的
 *     小工具集覆盖。当前 agent 的真实清单只能取"上一次该 agent 的 assemble 输出"。
 *
 * 注意：本插件的“冻结”只作用于**即将交付的请求**，不改变注册表事实，
 * 也不阻止任何插件注册/注销工具。模型若调用已停用工具，由宿主按"未知工具"处理。
 */

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
  const injectList = config.listSection !== false;
  const verbose = config.verbose !== false;

  /** name -> { schema, firstIndex }：本进程见过的全部工具（首次出现顺序）。 */
  const everSeen = new Map();
  let seq = 0;
  /** 上一次冻结**后**交付的工具名（含被补回的已停用项）。 */
  let lastDelivered = [];
  /**
   * 每个 agent 各自的上一次**真实**工具名（agent 作用域视角）。
   * 用 WeakMap 而不是单个变量：同一个进程里会有多个 agent（主 agent、标题生成等）
   * 跑 assemble，它们看到的工具集不同，混在一个变量里会互相覆盖。
   */
  const liveByAgent = new WeakMap();
  /** 无 agent 可归属时的兜底真实清单。 */
  let fallbackLive = [];
  /** 上一次真实清单的指纹，用于只在变化时打日志。 */
  let lastLiveKey = '';
  /** 上一次被冻结补回的工具名 —— 这就是"被停用"的准确集合。 */
  let lastRestored = [];
  /** 清单来源的诊断指纹（只在变化时打日志）。 */
  let scopeAnnounced = '';

  const namesOf = (tools) =>
    Array.isArray(tools)
      ? tools.map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean)
      : [];

  // ---- 1) 冻结交付的工具声明 -------------------------------------------
  ctx.effect(() => {
    let headerLogged = false;
    const handler = async (assembly, context, next) => {
      const result = await next();
      try {
        if (!result || !Array.isArray(result.tools)) return result;

        // 冻结前的真实清单（agent 作用域视角）
        const liveNow = namesOf(result.tools);
        const agent = context?.agent;
        // 只增不减地记"该 agent 见过的最大集合"：assemble 会被同一 agent 以不同
        // 时机调用（MCP 工具的注入是异步的、插件仍在注册等），中间态的工具集更小；
        // 若用小集合覆盖，清单就会漏报。工具真被删除时由 lastRestored 段说明。
        const prevLive = (agent !== undefined && agent !== null ? liveByAgent.get(agent) : undefined) ?? fallbackLive;
        if (liveNow.length >= prevLive.length) {
          if (agent !== undefined && agent !== null) liveByAgent.set(agent, liveNow);
          else fallbackLive = liveNow;
        }
        const liveKey = [...liveNow].sort().join('\u0001');
        if (liveKey !== lastLiveKey) {
          lastLiveKey = liveKey;
          if (verbose) log(`live tools = ${liveNow.length} (max seen = ${Math.max(liveNow.length, prevLive.length)})`);
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

        if (freezeTools && (baselineTools.length > 0 || everSeen.size > 0)) {
          const byName = new Map();
          for (const tool of result.tools) {
            if (tool && typeof tool.name === 'string') byName.set(tool.name, tool);
          }
          const merged = [];
          const restored = [];
          const seen = new Set();
          // ① 基线顺序优先：当前还活着的用当前定义，缺失的用基线/快照补回
          for (const base of baselineTools) {
            if (!base || typeof base.name !== 'string' || seen.has(base.name)) continue;
            seen.add(base.name);
            const live = byName.get(base.name);
            if (live !== undefined) merged.push(live);
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
          lastDelivered = namesOf(merged);
          lastRestored = restored;
          if (restored.length > 0 && verbose) {
            log(`froze back ${restored.length} retired tool(s): ${restored.join(', ')}`);
          }
        } else {
          lastDelivered = namesOf(result.tools);
          lastRestored = [];
        }
      } catch (error) {
        log('freeze failed:', error?.message);
      }
      return result;
    };

    ctx.on('system-prompt/assemble', handler);
    if (verbose) log(`freeze hook installed (freezeTools=${freezeTools})`);
    return () => {
      /* ctx.on 的 disposer 由 effect 作用域回收 */
    };
  }, 'dsh-tool-freeze.freeze');

  // ---- 2) 追加「当前可用工具」系统段落 ---------------------------------
  if (injectList) {
    const renderList = (promptContext) => {
      // section 的求值早于 assemble waterfall，拿不到本轮的 assembly.tools；
      // 但可以**实时**按本次装配的作用域查注册表视图（这才是"此刻真正可用"）。
      // ⚠️ 不能用 schemas(undefined)：那是全局层视角，看不到 agent / preset / MCP
      // 作用域注册的工具。作用域取自 assemble 的 context.scope。
      const scope = promptContext?.scope;
      let live = [];
      let source = 'scope';
      try {
        const s = ctx.tools?.schemas?.(scope);
        if (Array.isArray(s)) live = namesOf(s);
      } catch (error) {
        log('schemas(scope) threw:', error?.message);
      }
      if (live.length === 0) {
        // 兜底：本 agent 上一次的 assemble 输出
        const agent = promptContext?.agent;
        live = (agent !== undefined && agent !== null ? liveByAgent.get(agent) : undefined) ?? fallbackLive;
        source = 'last-assemble';
      }
      if (verbose && scopeAnnounced !== `${scope === undefined ? 'undef' : 'ok'}:${live.length}`) {
        scopeAnnounced = `${scope === undefined ? 'undef' : 'ok'}:${live.length}`;
        log(`list source=${source} scope=${scope === undefined ? 'undefined' : 'present'} live=${live.length}`);
      }

      const liveSorted = [...live].sort();
      if (liveSorted.length === 0) return '';
      const liveSet = new Set(liveSorted);
      // 只报"声明里有、真实却不可用"的那批 —— 即上一轮被冻结补回的项
      const retired = [...new Set(lastRestored)].filter((n) => !liveSet.has(n)).sort();

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
