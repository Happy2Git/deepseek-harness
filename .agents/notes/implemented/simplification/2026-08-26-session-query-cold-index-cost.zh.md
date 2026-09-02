# Agent Note：移除会话查询索引中的逐事件复制与即时哈希

Status: implemented

[English](2026-08-26-session-query-cold-index-cost.md) | 中文

## 问题

在真实的 127 份日志语料（746 万条事件、4.1 万份文档、5400 万个被索引字符）上从零构建 SQLite 会话查询索引需要 41 秒，而在 `openAt: 'first-search'` 下这笔开销全部落在第一次 `searchSessions` 调用里。分阶段计时把它归因于 `observeSession`，而非 I/O 或 SQLite：41 秒中有 30.8 秒是事件观察，其中 18.3 秒是 `events.map(event => structuredClone(event))`，5.3 秒是对整份日志 `JSON.stringify` 后的 SHA-256。

这两笔开销都没有换来任何东西。`ObservedSession` 只暴露 `header`、`documents` 和 `fingerprint`，被克隆的事件数组从未被保留；`buildSessionEventSearchDocuments` 接收 `readonly SessionEvent[]`，并把它保留的每个字段都复制出来。指纹只在两处被读取，且都在 live 路径上（`liveChanges` 比较与 `temp.live_sessions` 插入）；持久化会话依据其持久化 revision 检测变更，`persisted_sessions` 表没有指纹列，因此索引 127 份持久化日志时算出的哈希被直接丢弃。

## 决策

`observeSession` 直接读取调用方的事件日志，并通过带缓存的 getter 计算指纹。

去掉复制是安全的，因为整个函数体是同步的：投影与哈希都在任何 `await` 能让 live 会话追加事件之前完成。该复制只能防御消费方保留或修改日志，而唯一的消费方两者都不做。`header` 仍然克隆，它是一个小对象，且观察结果会保存它。

指纹改为惰性求值不改变其取值。两处读取都运行在产生该观察结果的同一个 `_observeStable` 返回值的同步后续中，因此在观察 live 会话与对其哈希之间不会有追加插入；持久化路径从不读取该属性，现在也就不再哈希。

## 备选方案

**对派生索引设置 `PRAGMA synchronous = NORMAL`。** 实测后否决：协调本就在单个事务中提交，两种设置下都只有一次 fsync，实测确认无变化（19.11 秒对 19.14 秒）。听起来正确，实则无效。

**协调期间对 `persistence.inspect` 施加有界并发。** 实现后回退：41.1 秒对 41.2 秒。瓶颈是主线程 CPU，Promise 并发无法分摊。它还会让此前未被消费的 `persistedInspectConcurrency` 配置在 sqlite 协调路径上生效；与其交付一个换不来收益的旋钮，不如让它继续闲置。

**批量执行逐文档的 FTS5 插入。** 实测后否决：合成的 4.1 万行批量插入耗时 250 毫秒，而真实语料需要 7.2 秒，因此代价来自对 5400 万字符的 trigram 分词，而非语句派发。多行 `VALUES` 不会减少分词工作量。

**为对称起见，也给持久化会话存一份指纹。** 否决：持久化 revision 已经回答了指纹所回答的问题，为复制这个答案而对每份持久化日志做哈希，正是本记录要移除的开销。

## 影响

同一语料上的冷构建从 41.1 秒降至 20.6 秒；热查询维持在约 230 毫秒不变，结果完全一致。剩余的冷启动开销是约 8 秒的日志读取与解码，以及约 8.8 秒的 FTS5 trigram 分词，两者都是实际工作。选择启用 [`tokenize: trigram`](../architecture/2026-08-22-session-query-trigram-tokenizer.md) 的部署，其一次性重建的代价降为此前的一半。

`ObservedSession.fingerprint` 现在是一个访问器。对 `ObservedSession` 做序列化或结构化克隆会强制触发哈希；目前没有代码这样做，两处 live 读取都直接访问该属性。

一个回归测试在两次搜索之间向 live 会话追加事件，并断言第二次搜索能看到新事件。把指纹替换为常量会让它失败，这正好锁定了被移除的复制与即时哈希所掩盖的变更检测契约。
