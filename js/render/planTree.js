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

// Pre-order x-assignment over the spanning tree rooted at rootIdx. Non-root
// fragments are placed below their matching EXCHANGE; if multiple fragments
// would collide horizontally, push later fragments (by ascending fragmentId)
// rightward by their subtree width + H_GAP.
export function layoutPlan(plan) {
  const pos = new Array(plan.nodes.length).fill(null).map(() => ({ x: 0, y: 0 }));
  const depths = computeDepths(plan);
  const widths = computeSubtreeWidths(plan);

  function assignSubtree(idx, centerX) {
    pos[idx].x = centerX;
    pos[idx].y = (depths[idx] ?? 0) * (NODE_H + V_GAP);
    const node = plan.nodes[idx];
    if (node.childrenIdx.length === 0) return;
    let leftEdge = centerX - widths[idx] / 2;
    for (const childIdx of node.childrenIdx) {
      const cw = widths[childIdx];
      assignSubtree(childIdx, leftEdge + cw / 2);
      leftEdge += cw + H_GAP;
    }
  }

  if (plan.rootIdx !== null) assignSubtree(plan.rootIdx, 0);

  const placedRanges = [];
  if (plan.rootIdx !== null) {
    const globalFragId = plan.nodes[plan.rootIdx].fragmentId;
    const rootW = widths[plan.fragmentRoots[globalFragId]];
    placedRanges.push({
      fragmentId: globalFragId,
      xMin: -rootW / 2,
      xMax:  rootW / 2,
    });
  }

  for (const fragRootIdx of plan.fragmentRoots) {
    if (fragRootIdx === null) continue;
    const fragId = plan.nodes[fragRootIdx].fragmentId;
    if (plan.rootIdx !== null && fragId === plan.nodes[plan.rootIdx].fragmentId) continue;

    const exch = plan.nodes.find(
      n => n.crossFragmentLink && n.crossFragmentLink.peerIdx === fragRootIdx
    );
    let centerX = exch ? pos[exch.idx].x : 0;
    const w = widths[fragRootIdx];
    let xMin = centerX - w / 2;
    let xMax = centerX + w / 2;
    let collision = true;
    while (collision) {
      collision = false;
      for (const r of placedRanges) {
        if (xMin < r.xMax && xMax > r.xMin) {
          const shift = (r.xMax + H_GAP) - xMin;
          xMin += shift; xMax += shift; centerX += shift;
          collision = true;
          break;
        }
      }
    }
    assignSubtree(fragRootIdx, centerX);
    placedRanges.push({ fragmentId: fragId, xMin, xMax });
  }

  return pos;
}
