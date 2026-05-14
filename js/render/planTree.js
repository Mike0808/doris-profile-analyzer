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
