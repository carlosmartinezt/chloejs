import type { ReactNode } from "react";

/** Small line icons, sized by the text beside them and coloured by it. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** More that can be done with something, in a menu. */
export const More = () => (
  <Icon>
    <circle cx="8" cy="3.5" r=".6" fill="currentColor" />
    <circle cx="8" cy="8" r=".6" fill="currentColor" />
    <circle cx="8" cy="12.5" r=".6" fill="currentColor" />
  </Icon>
);

/** Looking closely at one agent. */
export const Inspect = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 L14 14" />
  </Icon>
);

/** Changing what it is: its instructions, its skills, its jobs. */
export const Edit = () => (
  <Icon>
    <path d="M2.6 13.4h3.1l7-7a1.6 1.6 0 0 0 0-2.2l-.9-.9a1.6 1.6 0 0 0-2.2 0l-7 7Z" />
    <path d="M9 4.4 11.6 7" />
  </Icon>
);

/** Saying something to it. */
export const Chat = () => (
  <Icon>
    <path d="M13.5 9.2a1.8 1.8 0 0 1-1.8 1.8H6l-3 2.4V4.3a1.8 1.8 0 0 1 1.8-1.8h6.9a1.8 1.8 0 0 1 1.8 1.8Z" />
  </Icon>
);

/** What it has been doing: line after line. */
export const Log = () => (
  <Icon>
    <path d="M2.4 4h11.2M2.4 8h11.2M2.4 12h7" />
  </Icon>
);

/** A folder, shut. */
export const Folder = () => (
  <Icon>
    <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z" />
  </Icon>
);

/** A folder, open. */
export const FolderOpen = () => (
  <Icon>
    <path d="M2 12V4.5a1 1 0 0 1 1-1h3.5L8 5h4a1 1 0 0 1 1 1v1" />
    <path d="M2 12l1.6-4.2a1 1 0 0 1 .9-.6h9.3a.6.6 0 0 1 .6.8L13 12.4a1 1 0 0 1-.9.6H3a1 1 0 0 1-1-1Z" />
  </Icon>
);

/** A file. */
export const File = () => (
  <Icon>
    <path d="M4 2h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
    <path d="M9 2v3h3" />
  </Icon>
);

/** The files in a memory, as a tree. */
export const Files = () => (
  <Icon>
    <path d="M5 1.8h4.5L12 4.3v7.2a.8.8 0 0 1-.8.8H5a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z" />
    <path d="M2.4 4.4v8.9c0 .5.4.9.9.9h6.5" />
  </Icon>
);

/** What runs on a clock. */
export const Clock = () => (
  <Icon>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.4 1.6" />
  </Icon>
);

/** What an agent can do: a tool it picks up. */
export const Tool = () => (
  <Icon>
    <path d="M10.3 1.9a3.4 3.4 0 0 0-4 4.5l-4 4a1.3 1.3 0 0 0 1.8 1.8l4-4a3.4 3.4 0 0 0 4.5-4L10.8 6 8.8 5.6 8.4 3.6Z" />
  </Icon>
);

/** What changed, in a memory that is a git repository. */
export const Branch = () => (
  <Icon>
    <circle cx="4.5" cy="3.5" r="1.4" />
    <circle cx="4.5" cy="12.5" r="1.4" />
    <circle cx="11.5" cy="5.5" r="1.4" />
    <path d="M4.5 4.9v6.2M11.5 6.9c0 2.4-3 2.1-6.2 4.3" />
  </Icon>
);

/** Shut a tab. */
export const Close = () => (
  <Icon>
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </Icon>
);

/** What a memory has served, and to whom. */
export const Record = () => (
  <Icon>
    <path d="M3 3.5h10M3 8h10M3 12.5h6" />
  </Icon>
);

/** How the memory view looks. */
export const Look = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
  </Icon>
);

/** A password shown as it was typed. */
export const Eye = () => (
  <Icon>
    <path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Icon>
);

/** The same, hidden again. */
export const EyeOff = () => (
  <Icon>
    <path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8s-2.4 4.3-6.5 4.3S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.9" />
    <path d="M2.6 2.6l10.8 10.8" />
  </Icon>
);

/** The way a menu opens, beside the thing that opens it. */
export const Down = () => (
  <Icon>
    <path d="M4 6.5 8 10.5l4-4" />
  </Icon>
);

/** A list of places, folded away until it is asked for: three lines. */
export const Menu = () => (
  <Icon>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);

/** One agent as a whole: what it is, what it runs, what it has done. */
export const Card = () => (
  <Icon>
    <rect x="2.4" y="3" width="11.2" height="10" rx="1.6" />
    <path d="M2.4 6.4h11.2M5.6 9.2h5.2M5.6 11h3" />
  </Icon>
);

/** A way in: something arriving from outside. */
export const In = () => (
  <Icon>
    <path d="M9.4 2.6h2.8a1.4 1.4 0 0 1 1.4 1.4v8a1.4 1.4 0 0 1-1.4 1.4H9.4" />
    <path d="M2.6 8h6.6M6.8 5.4 9.4 8l-2.6 2.6" />
  </Icon>
);

/** A way out: something leaving for somewhere else. */
export const Out = () => (
  <Icon>
    <path d="M6.6 2.6H3.8a1.4 1.4 0 0 0-1.4 1.4v8a1.4 1.4 0 0 0 1.4 1.4h2.8" />
    <path d="M6.8 8h6.6M10.8 5.4 13.4 8l-2.6 2.6" />
  </Icon>
);

/** What an agent remembers: a book, held open. */
export const Memory = () => (
  <Icon>
    <path d="M8 4.3C6.8 3.3 5.3 2.9 3 2.9v8.5c2.3 0 3.8.4 5 1.4 1.2-1 2.7-1.4 5-1.4V2.9c-2.3 0-3.8.4-5 1.4Z" />
    <path d="M8 4.3v9.5" />
  </Icon>
);

/** Starting a conversation that has nothing in it yet. */
export const Plus = () => (
  <Icon>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Icon>
);

/** Sending what has been typed. */
export const Send = () => (
  <Icon>
    <path d="M8 13V3.6M4.2 7.4 8 3.4l3.8 4" />
  </Icon>
);

/** Taking a copy of something, onto the clipboard. */
export const Copy = () => (
  <Icon>
    <rect x="5.6" y="5.6" width="8" height="8" rx="1.6" />
    <path d="M10.4 3.4H3.9a1.6 1.6 0 0 0-1.6 1.6v6.5" />
  </Icon>
);

/** It worked. */
export const Tick = () => (
  <Icon>
    <path d="m3.2 8.4 3.2 3.2 6.4-7" />
  </Icon>
);

/** Loading the page again. */
export const Reload = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.6v2.6h-2.6" />
  </Icon>
);
