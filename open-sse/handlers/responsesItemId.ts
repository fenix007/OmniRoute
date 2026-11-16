type Item = Record<string, unknown>;

function idString(value: unknown): string {
  return value == null ? "" : String(value);
}

/** Restore a missing terminal ID only from an authoritative matching done item. */
export function recoverCompletedItemId(
  item: Item,
  completed: Item | undefined,
  isTerminalOutput: boolean
): unknown {
  const id = item.id != null ? String(item.id) : item.id;
  if (
    !isTerminalOutput ||
    idString(id).trim() ||
    !completed ||
    !idString(completed.id).trim() ||
    item.type !== completed.type ||
    idString(item.call_id) !== idString(completed.call_id) ||
    idString(item.name) !== idString(completed.name)
  ) {
    return id;
  }
  return String(completed.id);
}

export function toResponseOutputIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}
