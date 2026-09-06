"""409 撞冲突的节点不再永久拉黑，改成用服务端快照 rebase 本地那一个节点。一次性脚本。"""
import io

P = 'src/canvas/store/canvasStore.ts'
s = io.open(P, encoding='utf-8', newline='').read()
NL = '\r\n' if '\r\n' in s else '\n'


def rep(old, new, n=1):
    global s
    old = old.replace('\n', NL)
    new = new.replace('\n', NL)
    assert s.count(old) == n, (repr(old[:70]), s.count(old), n)
    s = s.replace(old, new)


# ── 1. 错误负载类型补上服务端回传的节点快照 ──
rep(
    "          errorCode?: string;\n"
    "          changedNodeKeys?: string[];\n"
    "          currentVersion?: number;",

    "          errorCode?: string;\n"
    "          changedNodeKeys?: string[];\n"
    "          currentVersion?: number;\n"
    "          // upsert 的 409 会带上服务端当前那份节点快照（见 canvasRoutes.js 的\n"
    "          // nodes/upsert）。有它就能把本地这一个节点 rebase 回服务端版本。\n"
    "          node?: CanvasNode | null;",
)

# ── 2. rebase 助手 ──
rep(
    "function isRetryableNodeSaveError(error: unknown) {",

    "/** 一轮保存里最多 rebase 这么多个节点。超出就退回"跳过"，避免病态状态下反复重写节点。 */\n"
    "const MAX_REBASE_PER_PASS = 8;\n"
    "\n"
    "/**\n"
    " * 用服务端 409 带回来的快照把本地这一个节点 rebase 回去，返回是否真的 rebase 了。\n"
    " *\n"
    " * 直接复用 applyRemoteNodeEvent —— 它本来就在做"用服务端快照替换本地一个节点"，并且顺带\n"
    " * 处理了三件容易漏的事：版本号取 data._collabVersion 而不是事件里的 nodeVersion、重算指纹\n"
    " * 基线、markNodesRemoteOrigin（否则 undo 会把它当成本页新建的节点删掉）。\n"
    " *\n"
    " * 唯一要绕开的是它那条"本地与基线指纹不一致就拒绝覆盖"的护栏：走到这里的节点**一定**是脏的\n"
    " * （保存循环只 upsert 指纹变了的节点），那条护栏必然拦住。所以先把基线清掉再调 —— 这一步\n"
    " * 等于明确声明"这一个节点以服务端为准"。\n"
    " */\n"
    "function rebaseConflictedNode(\n"
    "  projectUuid: string,\n"
    "  nodeKey: string,\n"
    "  snapshot?: CanvasNode | null,\n"
    "  serverVersion?: number,\n"
    ") {\n"
    "  if (!snapshot) return false;\n"
    "  nodeFingerprintsByProject.get(projectUuid)?.delete(nodeKey);\n"
    "  try {\n"
    "    useCanvasStore.getState().applyRemoteNodeEvent({\n"
    "      // 不带事件 id：applyRemoteNodeEvent 的游标判重只在 id 非 0 时生效，而这份快照\n"
    "      // 不是从事件流来的，不该推进游标（推了会漏掉后面真正的远端事件）。\n"
    "      id: 0,\n"
    "      nodeKey,\n"
    "      nodeVersion: 0,\n"
    "      eventType: \"upsert\",\n"
    "      node: snapshot,\n"
    "    });\n"
    "  } catch (error) {\n"
    "    console.error(\"[canvas] rebase 冲突节点失败\", nodeKey, error);\n"
    "    return false;\n"
    "  }\n"
    "  const versions = nodeVersionsByProject.get(projectUuid);\n"
    "  if (!versions?.has(nodeKey)) return false;\n"
    "  // 兜底对齐：服务端乐观锁比的是 _collabVersion，快照里那个值理应等于 currentVersion。\n"
    "  // 万一是早期遗留节点、快照里的 _collabVersion 停在 0，下一轮保存又会带着 0 去撞 409，\n"
    "  // 变成死循环。以服务端给的 currentVersion 为准。\n"
    "  const aligned = Number(serverVersion || 0);\n"
    "  if (aligned && versions.get(nodeKey) !== aligned) versions.set(nodeKey, aligned);\n"
    "  return true;\n"
    "}\n"
    "\n"
    "function isRetryableNodeSaveError(error: unknown) {",
)

# ── 3. 保存循环里的 catch：改成 rebase ──
rep(
    "      } catch (error) {\n"
    "        if (nodeSaveErrorData(error)?.errorCode !== \"CANVAS_NODE_VERSION_CONFLICT\") throw error;\n"
    "        // 只有这一个节点服务端更新过。跳过它、继续存别的，不要连坐整个画布。\n"
    "        conflictedNodes.add(nodeKey);\n"
    "        conflictedNodesByProject.set(projectUuid, conflictedNodes);\n"
    "        freshConflicts.push(nodeKey);\n"
    "        continue;\n"
    "      }",

    "      } catch (error) {\n"
    "        const conflictData = nodeSaveErrorData(error);\n"
    "        if (conflictData?.errorCode !== \"CANVAS_NODE_VERSION_CONFLICT\") throw error;\n"
    "        // 只有这一个节点服务端更新过。跳过它、继续存别的，不要连坐整个画布。\n"
    "        freshConflicts.push(nodeKey);\n"
    "        // 撞冲突的绝大多数情况是"这一页自己的生成结果回来了"：任务完成时服务端把结果写回\n"
    "        // 节点、版本 +1，而这一轮保存带的还是写回之前的版本号。2026-08-17 线上统计：55 次\n"
    "        // 409 里 52 次都落在任务轮询 / apply 的 ±5s 内，跟"别人在改你的画布"无关。\n"
    "        //\n"
    "        // 以前这里把节点加进 conflictedNodes 永久拉黑、不再重试，而那个名单只在 loadProject\n"
    "        // 时清空 —— 后果是生成一完成，那个节点就从这一页的保存里被摘出去：之后你移动它、\n"
    "        // 改它的提示词都不会落库，直到刷新或点"加载最新版本"。这比多弹一条横幅严重得多。\n"
    "        //\n"
    "        // 现在用 409 带回来的服务端快照把这一个节点 rebase 回去，版本号和指纹基线都对齐，\n"
    "        // 下一轮保存就能正常写。代价是本地对这个节点的那一次待存改动被丢弃 —— 主场景里它\n"
    "        // 就是生成进度状态，而服务端那份才是带着生成结果的权威版本。横幅照旧弹。\n"
    "        const rebased = rebasedThisPass < MAX_REBASE_PER_PASS\n"
    "          && rebaseConflictedNode(projectUuid, nodeKey, conflictData.node, conflictData.currentVersion);\n"
    "        if (rebased) {\n"
    "          rebasedThisPass += 1;\n"
    "        } else {\n"
    "          // 拿不到快照（别的 409 形态）或这一轮 rebase 已经太多：退回老行为，\n"
    "          // 至少不会每轮保存都为它打一次 409。\n"
    "          conflictedNodes.add(nodeKey);\n"
    "          conflictedNodesByProject.set(projectUuid, conflictedNodes);\n"
    "        }\n"
    "        continue;\n"
    "      }",
)

# ── 4. 计数器 ──
rep(
    "    const conflictedNodes =\n"
    "      conflictedNodesByProject.get(projectUuid) ?? new Set<string>();\n"
    "    const freshConflicts: string[] = [];",

    "    const conflictedNodes =\n"
    "      conflictedNodesByProject.get(projectUuid) ?? new Set<string>();\n"
    "    const freshConflicts: string[] = [];\n"
    "    let rebasedThisPass = 0;",
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('canvasStore.ts 已改')
