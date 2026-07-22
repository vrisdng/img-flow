import type { GroupSnapshot } from "./types.js";
export type Group = { id: string; label: string; notes?: string };
export type Member = {
  group_id: string;
  material_id: string;
  position: number;
};
export type GroupEdge = {
  source_group_id: string;
  target_group_id: string;
  position: number;
};
export function wouldCreateCycle(
  edges: GroupEdge[],
  source: string,
  target: string,
) {
  if (source === target) return true;
  const children = new Map<string, string[]>();
  for (const e of edges)
    children.set(e.target_group_id, [
      ...(children.get(e.target_group_id) ?? []),
      e.source_group_id,
    ]);
  const visit = (id: string, seen = new Set<string>()): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (children.get(id) ?? []).some((next) => visit(next, seen));
  };
  return visit(source);
}
export function resolveGroups(
  rootIds: string[],
  groups: Group[],
  members: Member[],
  edges: GroupEdge[],
  limit = 15,
) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const childEdges = new Map<string, GroupEdge[]>();
  for (const e of edges)
    childEdges.set(
      e.target_group_id,
      [...(childEdges.get(e.target_group_id) ?? []), e].sort(
        (a, b) => a.position - b.position,
      ),
    );
  const memberMap = new Map<string, Member[]>();
  for (const m of members)
    memberMap.set(
      m.group_id,
      [...(memberMap.get(m.group_id) ?? []), m].sort(
        (a, b) => a.position - b.position,
      ),
    );
  const materialIds: string[] = [],
    seen = new Set<string>(),
    snapshots: GroupSnapshot[] = [],
    stack = new Set<string>();
  const walk = (groupId: string, path: string[]) => {
    const group = byId.get(groupId);
    if (!group) throw new Error("A connected material group is missing.");
    if (stack.has(groupId)) throw new Error("Material groups contain a cycle.");
    stack.add(groupId);
    const nextPath = [...path, group.label];
    const own = (memberMap.get(groupId) ?? []).map((m) => m.material_id);
    snapshots.push({
      id: group.id,
      label: group.label,
      notes: group.notes?.trim() || undefined,
      path: nextPath,
      materialIds: [...own],
    });
    for (const edge of childEdges.get(groupId) ?? [])
      walk(edge.source_group_id, nextPath);
    for (const materialId of own)
      if (!seen.has(materialId)) {
        seen.add(materialId);
        materialIds.push(materialId);
      }
    stack.delete(groupId);
  };
  for (const root of rootIds) walk(root, []);
  if (materialIds.length > limit)
    throw new Error(
      `Resolved groups contain ${materialIds.length} materials; maximum is ${limit}.`,
    );
  return { materialIds, groupSnapshots: snapshots };
}
