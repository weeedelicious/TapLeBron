const crypto = require('crypto');

function nodeListVersion(nodes) {
  return crypto.createHash('sha1').update(JSON.stringify(nodes || [])).digest('hex');
}

function nodeMap(nodes) {
  return new Map((nodes || []).map((node) => [String(node.nodeKey), node]));
}

function sameNode(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeNodeSnapshots(baseNodes, incomingNodes, currentNodes) {
  const base = nodeMap(baseNodes);
  const incoming = nodeMap(incomingNodes);
  const current = nodeMap(currentNodes);
  const changedNodeKeys = [];
  const conflictNodeKeys = [];
  const allKeys = new Set([...base.keys(), ...incoming.keys()]);

  for (const nodeKey of allKeys) {
    const baseNode = base.get(nodeKey);
    const incomingNode = incoming.get(nodeKey);
    if (sameNode(baseNode, incomingNode)) continue;
    changedNodeKeys.push(nodeKey);
    const currentNode = current.get(nodeKey);
    if (sameNode(currentNode, baseNode)) {
      if (incomingNode === undefined) current.delete(nodeKey);
      else current.set(nodeKey, incomingNode);
      continue;
    }
    if (sameNode(currentNode, incomingNode)) continue;
    conflictNodeKeys.push(nodeKey);
  }

  if (conflictNodeKeys.length) {
    return { merged: false, nodes: currentNodes, changedNodeKeys, conflictNodeKeys };
  }

  const currentOrder = (currentNodes || []).map((node) => String(node.nodeKey));
  const appendedKeys = (incomingNodes || [])
    .map((node) => String(node.nodeKey))
    .filter((nodeKey) => !currentOrder.includes(nodeKey));
  const order = [...currentOrder, ...appendedKeys];
  return {
    merged: true,
    nodes: order.flatMap((nodeKey) => current.has(nodeKey) ? [current.get(nodeKey)] : []),
    changedNodeKeys,
    conflictNodeKeys: [],
  };
}

module.exports = { mergeNodeSnapshots, nodeListVersion };
