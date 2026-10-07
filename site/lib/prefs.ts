// How the page looks, remembered per browser: the colour theme, light or dark,
// the band across the top, the document style for HTML notes with no
// stylesheet of their own, the minimap, and how a folder's table is sorted.
// Every read and write survives storage that is missing or full, and falls
// back to the first choice.

/** The looks. The first is the page's own, and is no attribute at all. */
export const THEMES: [string, string][] = [
  ["", "Chloe"],
  ["chrome", "Chrome"],
  ["light-plus", "Light+"],
  ["quiet-light", "Quiet Light"],
  ["dark-plus", "Dark+"],
  ["dark-modern", "Dark Modern"],
  ["abyss", "Abyss"],
  ["monokai", "Monokai"],
  ["monokai-dimmed", "Monokai Dimmed"],
  ["kimbie-dark", "Kimbie Dark"],
  ["red", "Red"],
  ["tomorrow-night-blue", "Tomorrow Night Blue"],
];

export type SortBy = "name" | "size" | "modified";
export interface Sort {
  by: SortBy;
  down: boolean;
}

function load(key: string): string {
  try {
    return localStorage.getItem(`chloe.${key}`) ?? "";
  } catch {
    return "";
  }
}

function save(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(`chloe.${key}`, value);
    else localStorage.removeItem(`chloe.${key}`);
  } catch {
    // A private window. The choice holds until the page is reloaded.
  }
}

export const theme = (): string => (THEMES.some(([name]) => name === load("theme")) ? load("theme") : "");

/** Light, dark, or whatever this computer is set to, which is the first. */
export type Mode = "" | "light" | "dark";

export const MODES: [Mode, string][] = [
  ["", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

export const mode = (): Mode => {
  const kept = load("mode");
  return kept === "light" || kept === "dark" ? kept : "";
};

/**
 * Pins Chloe's own look to one or the other, or lets it follow the system
 * again. It is `color-scheme` that decides, and every colour in that look is
 * written as light-dark(), so this one attribute moves all of them. The other
 * looks each carry one or the other already and this does not reach them.
 */
export function setMode(next: Mode): void {
  save("mode", next);
  if (next) document.documentElement.setAttribute("data-mode", next);
  else document.documentElement.removeAttribute("data-mode");
}

/**
 * The band across the top, which is one hue and nothing else. The first is the
 * default and is nothing stored. Only Chloe's own look uses it: the rest name
 * their own bar.
 */
export const BARS: [string, string][] = [
  ["222", "Ink"],
  ["192", "Teal"],
  ["152", "Moss"],
  ["285", "Plum"],
  ["336", "Wine"],
  ["22", "Clay"],
];

export const bar = (): string => {
  const kept = load("bar");
  return BARS.some(([hue]) => hue === kept) ? kept : BARS[0][0];
};

export function setBar(hue: string): void {
  save("bar", hue === BARS[0][0] ? "" : hue);
  document.documentElement.style.setProperty("--bar-hue", hue);
  // What a phone paints around the page when it is installed. The same band.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", `hsl(${hue} 50% 30%)`);
}

/** Sets the theme on the page. index.html does the same before the first paint. */
export function setTheme(name: string): void {
  save("theme", name);
  if (name) document.documentElement.setAttribute("data-theme", name);
  else document.documentElement.removeAttribute("data-theme");
}

/** Whether HTML notes with no stylesheet of their own get a reading layout. */
export const docStyle = (): boolean => load("docStyle") === "basic";
export const setDocStyle = (on: boolean): void => save("docStyle", on ? "basic" : "");

/** On unless it was turned off. */
export const minimap = (): boolean => load("minimap") !== "off";
export const setMinimap = (on: boolean): void => save("minimap", on ? "" : "off");

export function sort(): Sort {
  const [by, way] = load("sort").split(":");
  return { by: by === "size" || by === "modified" ? by : "name", down: way === "down" };
}
export const setSort = (next: Sort): void => save("sort", `${next.by}:${next.down ? "down" : "up"}`);

/** How much of the log's width its list takes, as a share: two fifths unless dragged. */
export const logShare = (): number => Number(load("logShare")) || 0.4;
export const setLogShare = (share: number): void => save("logShare", share.toFixed(3));
