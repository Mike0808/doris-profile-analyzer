// Plan Tree renderer. Layout + SVG + pan/zoom + detail panel.
// Doris 3.x: https://doris.apache.org/docs/3.x/query-acceleration/tuning/profiling-tools/

export const NODE_W = 160;
export const NODE_H = 56;
export const H_GAP = 24;
export const V_GAP = 56;

// BFS from rootIdx through childrenIdx. Cross-fragment edges (exchange → peer
// sink) are followed only to assign a depth to peers that the spanning tree
// would not otherwise visit; peers retain their own parentIdx lineage.
export function computeDepths(plan) {
  const depths = new Array(plan.nodes.length).fill(null);
  if (plan.rootIdx === null) return depths;

  const queue = [plan.rootIdx];
  depths[plan.rootIdx] = 0;
  while (queue.length) {
    const idx = queue.shift();
    const node = plan.nodes[idx];
    for (const childIdx of node.childrenIdx) {
      if (depths[childIdx] !== null) continue;
      depths[childIdx] = depths[idx] + 1;
      queue.push(childIdx);
    }
    if (node.crossFragmentLink && node.crossFragmentLink.peerIdx !== null) {
      const peerIdx = node.crossFragmentLink.peerIdx;
      if (depths[peerIdx] === null) {
        depths[peerIdx] = depths[idx] + 1;
        queue.push(peerIdx);
      }
    }
  }
  return depths;
}

// Post-order: each leaf is NODE_W wide; each internal node is the sum of its
// children's widths plus inter-sibling gaps (at least NODE_W if the children
// pack tighter than the node itself).
export function computeSubtreeWidths(plan) {
  const widths = new Array(plan.nodes.length).fill(0);
  function recur(idx) {
    const node = plan.nodes[idx];
    if (node.childrenIdx.length === 0) {
      widths[idx] = NODE_W;
      return NODE_W;
    }
    let sum = 0;
    for (let i = 0; i < node.childrenIdx.length; i++) {
      sum += recur(node.childrenIdx[i]);
      if (i > 0) sum += H_GAP;
    }
    widths[idx] = Math.max(NODE_W, sum);
    return widths[idx];
  }
  if (plan.rootIdx !== null) recur(plan.rootIdx);
  for (const fragRootIdx of plan.fragmentRoots) {
    if (fragRootIdx !== null && widths[fragRootIdx] === 0) recur(fragRootIdx);
  }
  return widths;
}
