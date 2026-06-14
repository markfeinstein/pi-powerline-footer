// Layout helpers for arranging pre-rendered status content on a single row.
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Combine a left-aligned content string and a right-aligned content string into
 * a single row that is exactly `availableWidth` columns wide, by inserting
 * padding spaces between the two groups so the right group sits flush against
 * the right edge.
 *
 * Returns `null` when the two groups cannot fit side by side on one row (the
 * caller should fall back to a stacked / overflow layout). Either side may be
 * empty: an empty right group yields the left content unchanged (or `null` when
 * both sides are empty), and an empty left group right-aligns the right group on
 * its own.
 */
export function joinLeftRight(
  leftContent: string,
  rightContent: string,
  availableWidth: number,
): string | null {
  if (rightContent === "") {
    return leftContent === "" ? null : leftContent;
  }
  const leftWidth = visibleWidth(leftContent);
  const rightWidth = visibleWidth(rightContent);
  const pad = availableWidth - leftWidth - rightWidth;
  if (pad < 0) return null;
  return `${leftContent}${" ".repeat(pad)}${rightContent}`;
}
