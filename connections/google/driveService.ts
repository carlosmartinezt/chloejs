// Files in Drive, as the signed-in account, bound to a search like the mail
// is: the agent's config says which files (a Drive query, like
// `'<folder id>' in parents`), and the caller chooses only the words to look
// for. A file is read only if a search of the same binding listed it, so the
// binding is a boundary rather than a filter.
//
// A Google Doc, Sheet or Slides is read as text, through Drive, so a Doc needs
// nothing of its own.
import { googleApi, marked } from "./googleService.ts";

/** Where the files are. */
const FILES = "https://www.googleapis.com/drive/v3/files";

/** One file, as Google hands it back. */
interface GoogleFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** One file, as a search hands it back. */
export interface DriveFile {
  id: string;
  name: string;
  kind: string;
  modified?: string;
  link?: string;
}

/** The ids each binding has listed, so only those can be read. Capped, because the process outlives any run. */
const listed = new Map<string, Set<string>>();
const REMEMBER = 500;

function remember(search: string, files: DriveFile[]): void {
  let ids = listed.get(search);
  if (!ids) listed.set(search, (ids = new Set()));
  for (const { id } of files) {
    ids.delete(id);
    ids.add(id);
  }
  for (const oldest of ids) {
    if (ids.size <= REMEMBER) break;
    ids.delete(oldest);
  }
}

/** Words for a Drive query, with its quotes and backslashes escaped. */
const quoted = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** What the bound search matches, with these words in them when there are any. Nothing here widens it. */
export async function searchDriveFiles({
  search = "",
  text,
  limit = 20,
}: {
  search?: string;
  text?: string;
  limit?: number;
}): Promise<{ count: number; files: DriveFile[] }> {
  const query = [search.trim() && `(${search.trim()})`, "trashed = false", text?.trim() && `fullText contains ${quoted(text.trim())}`]
    .filter(Boolean)
    .join(" and ");
  const data = await googleApi<{ files?: GoogleFile[] }>(FILES, {
    query: {
      q: query,
      pageSize: limit,
      orderBy: text ? undefined : "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  });
  const files = (data.files ?? []).map(
    (one): DriveFile => ({
      id: one.id ?? "",
      name: one.name ?? "",
      kind: one.mimeType ?? "",
      modified: one.modifiedTime,
      link: one.webViewLink,
    }),
  );
  remember(search, files);
  return { count: files.length, files: files.map((one) => ({ ...one, name: marked(one.name) })) };
}

/** How much of one file is read. A file longer than this is cut, and says so. */
const MOST = 200_000;

/** What each kind of Google file is read as. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Whether a file that is not Google's own is text that can be read as it is. */
const isText = (kind: string) => /^text\/|json|xml|csv|markdown|yaml|javascript/.test(kind);

/**
 * One file as text. Refused unless a search of this binding listed it, and
 * when it is not text (a picture, a PDF), which is said rather than read.
 */
export async function readDriveFile({
  search = "",
  what,
  fileId,
}: {
  search?: string;
  what: string;
  fileId: string;
}): Promise<{ id: string; name: string; kind: string; text: string; cut: boolean }> {
  if (!listed.get(search)?.has(fileId)) {
    throw new Error(`That file is not in ${what}, or has not been listed yet. Search first and use an id from that list.`);
  }
  const at = `${FILES}/${encodeURIComponent(fileId)}`;
  const file = await googleApi<GoogleFile>(at, { query: { fields: "id,name,mimeType", supportsAllDrives: true } });
  const kind = file.mimeType ?? "";
  const as = EXPORTS[kind];
  let text: string;
  if (as) {
    text = await googleApi<string>(`${at}/export`, { query: { mimeType: as }, text: true });
  } else if (isText(kind)) {
    text = await googleApi<string>(at, { query: { alt: "media", supportsAllDrives: true }, text: true });
  } else {
    throw new Error(`${file.name} is ${kind || "not text"}, which cannot be read as text. Say where it is instead.`);
  }
  const cut = text.length > MOST;
  return { id: fileId, name: marked(file.name ?? ""), kind, text: marked(cut ? text.slice(0, MOST) : text), cut };
}
