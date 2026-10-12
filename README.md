# dsh-tool-freeze —— 工具面冻结 + 可用清单

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的插件。

**一句话**：让「工具变少」不再打断 KV 缓存前缀。

---

## 一、它解决什么问题

模型请求的哈希前缀顺序是 **`tools` → `system` → `messages`**
（Anthropic 官方文档：*Prompt caching hashes the request prefix in order: `tools`, then `system`, then `messages`*）。

也就是说，**工具声明排在整个请求的最前面**。于是只要工具集合少了一项——卸载插件、禁用插件、
热重载、在工具管理页里打勾——缓存前缀就从那一项起**全部失效**，长会话要把整段历史重算一遍。

实测（本机 desktop → rescue 切实例）：首轮 183,846 token 未命中、命中率 **1.5%**；
同一会话内禁用 3 个排在前面的工具：命中率从 97.8% 掉到 **8.8%**。

**为什么不能靠"增量删除"绕过**：提供方（DeepSeek 的 Anthropic 兼容端点）**只认 `tool_addition` 块，
不认 `tool_removal` 块**——实测报错：

```
Failed to deserialize the JSON body into the target type:
  messages[6].content: unknown variant `tool_removal`,
  expected one of `text`,`image`,...,`tool_addition`      (INVALID_REQUEST / 422)
```

所以"把工具从声明里拿掉"这件事，只能靠重印整张清单来表达 → 前缀必断。

---

## 二、它怎么做

两条互相配合的机制，**都不改 dsh 源码，也不碰工具注册表**：

### 1）冻结交付的工具声明

挂在 `system-prompt/assemble` waterfall 上（dsh 公开的扩展点），把即将交付的 `tools`
补成「**会话已声明的全集**」：

- 基线来源：`agent.session.requestHeader().tools` —— **会话已持久化的请求头**，
  所以**跨进程、跨实例重新接管同一会话**时同样有效；
- 缺失的工具用**消失前的 schema 快照**、按**首次出现的位置**回插
  （工具定义的顺序也会影响前缀，必须保序）；
- 新增的工具追加到末尾 —— 它本来就走 `tool_addition`，不破缓存。

因为 `header.tools` 与 `GenerateOptions.tools` 用的都是这份结果，所以整条链路一起冻结。

> 为什么不用「影子工具顶住注册表」：实测 `ctx.tools.register()` **拒绝同名重复注册**
> （`tool "X" is already registered`）。影子占住名字后，**真实插件重新启用会注册失败、
> 加载报错**——代价比收益大。冻结交付面没有这个副作用。

### 2）追加「当前可用工具」清单

注册一条系统段落（`ctx.systemPrompt.section`，`order: 9000`），内容是**仅名字**的可用清单 +
「已停用」列表。工具面变化 → 段落文本变化 → dsh 的 `in-history` 机制**自动把新快照作为
一条 system 角色消息追加到历史末尾**（实测该机制本身命中率 0.985–0.988）——
于是"告知模型谁还在"这件事本身也不破前缀。

清单措辞是**排他**的（"只有以下这些可以调用"），用来压住冻结带来的副作用：
模型可能仍会尝试调用声明里还列着、但实际已停用的工具。

---

## 三、实测效果

同一会话内连续制造工具增减（运行时 = dsh 0.2.1 本体 + 本插件），
判据是会话日志 `assistant/message.data.usage` 的 `inputTokens`（未命中）/ `cacheReadTokens`（命中）：

| 场景 | 真实工具数 | 声明里补回 | 未命中 | 命中率 |
|---|---|---|---|---|
| 建会话 | 24 | 0 | 250 | 96.6% |
| 不变 | 24 | 0 | 134 | 98.2% |
| 禁用 `tool-goal`（删清单首部 3 个） | 21 | 3 | 598 | **92.4%** |
| 禁用 `tool-web`（删清单尾部 2 个） | 22 | 2 | 710 | **91.7%** |
| 两个都禁用 | 19 | 5 | 578 | **93.6%** |
| 全部恢复 | 24 | 0 | 775 | 92.0% |

**对照组（不装本插件）**：删首部 3 个 → **8.8%**；删尾部 2 个 → **57.4%**。

清单侧同样可用日志验证：六轮会话产生 5 条 `system/message` 快照，每条对应一次工具面变化，
恢复后快照内容哈希回到与初始完全相同。

### 与「跨版本工具定义对齐」的分工（实测分离）

同一会话被两个不同 dsh 运行时交替接管（0.2.1 ↔ 0.2.0-rc.2，`profile` 相同）：

| 场景 | 不装本插件 | 装本插件 |
|---|---|---|
| 跨运行时交替接管（**三工具定义已对齐**） | 97.5% – 97.8% | 97.9% – 98.2% |
| 跨运行时交替接管（三工具定义**未对齐**） | 10.9% | — |
| 同一会话内**删减工具**（删清单首部 3 个） | **8.8%** | **92.4%** |

读法：

- **「同名工具定义跨版本对齐」解决的是另一件事** —— 同名重定义只能靠重建基线表达，
  本插件救不了它；对齐之后跨运行时接管就能保住前缀（97.5%+）。
- **本插件的增量价值集中在「工具集合增减」**：8.8% → 92.4%（+83.6 个百分点）。

两者互补，不重叠。

---

## 四、安装

```bash
# 装到某个 profile（把 <profile> 换成你的 profile 名）
dsh plugin --profile <profile> add 'link:/path/to/dsh-tool-freeze'
# 然后重启该实例
```

作为 bundle 装配（`dsh.bundle.patch` 会插入 `@local/dsh-tool-freeze` 这一行），
所以它会出现在插件列表里，也可以用正常的启停入口开关。

---

## 五、配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-tool-freeze
  config:
    freezeTools: true    # 冻结交付的工具声明（默认 true）
    listSection: true    # 追加「当前可用工具」系统段落（默认 true）
    verbose: true        # 往 stderr 打诊断日志（默认 true）
```

> ⚠️ patch 语义是**整字段替换**（不是深合并）：写了 `config` 就要把想保留的字段一起写全。

---

## 六、已知边界

| 情况 | 本插件能否救 |
|---|---|
| 插件卸载/禁用/热重载导致工具消失 | ✅ 声明保持全集，前缀不破 |
| 跨进程、跨实例接管同一会话 | ✅ 基线取自会话已持久化的请求头 |
| 新增工具 | ✅ 追加到末尾，本来就靠 `tool_addition` |
| **同名工具的定义改了** | ❌ 追加语义无法表达"替换一个已有名字的定义"，只能重建基线 |
| **系统提示词本身变了** | 与本插件无关（dsh 的 `in-history` 机制负责，通常不破） |
| **会话压缩 / 图片省略** | ❌ 表面替换 → 新请求序列，必断 |

**代价**：冻结意味着工具声明会持续包含已停用的工具（token 只增不减），
且每次工具面变化会追加一条完整的系统提示词快照。这是"用 token 换缓存"的自觉取舍，
与 dsh 自身 `in-history` 策略一致。

---

## 七、目录

```
package.json        包声明（dsh.bundle.patch 指向 cordis.patch.yml）
cordis.patch.yml    bundle 层：把本插件插进 profile 组合
lib/index.js        全部实现（无构建步骤，纯 ESM）
```
