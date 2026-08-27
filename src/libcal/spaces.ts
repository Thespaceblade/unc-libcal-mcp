import type { Page } from "playwright";
import { BASE_URL } from "../libcal/constants.js";

/** Map item IDs to human-readable names from the availability grid headers. */
export async function loadSpaceNames(page: Page, categoryPath: string): Promise<Map<number, string>> {
  await page.goto(`${BASE_URL}${categoryPath}`, { waitUntil: "networkidle" });

  const names = await page.evaluate(() => {
    const result = new Map<number, string>();
    const headers = document.querySelectorAll(".fc-datagrid-cell-main");
    headers.forEach((el, index) => {
      const text = el.textContent?.trim();
      if (text) result.set(index, text);
    });

    // LibCal also encodes eid on row elements
    document.querySelectorAll("[data-resource-id]").forEach((row) => {
      const id = Number((row as HTMLElement).dataset.resourceId);
      const label = row.querySelector(".fc-datagrid-cell-main")?.textContent?.trim();
      if (id && label) result.set(id, label);
    });

    return Object.fromEntries(result);
  });

  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(names)) {
    map.set(Number(key), value);
  }
  return map;
}

export function resolveSpaceName(names: Map<number, string>, itemId: number): string {
  return names.get(itemId) ?? `Space ${itemId}`;
}
