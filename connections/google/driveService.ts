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

/** One file in the list `searchDriveFiles` returns. */
export interface DriveFile {
  /** The file's id. Pass it to `readDriveFile` to read the file. */
  id: string;
  /**
   * The file's name. Wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers,
   * because someone else may have written it.
   */
  name: string;
  /**
   * The file's type, as Google writes it, such as
   * `"application/vnd.google-apps.document"` for a Google Doc, or
   * `"application/pdf"`.
   */
  kind: string;
  /** When the file was last changed, such as `"2026-10-06T19:00:00.000Z"`. */
  modified?: string;
  /** A link that opens the file in Google Drive. */
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

/**
 * Finds files in Google Drive. Files in the trash are left out.
 *
 * - `search`: a search in Drive's own search language that sets which files can be found, such as `"'<folder id>' in parents"` for the files in one folder. Default: `""`, every file the account can open.
 * - `text`: words to look for in the files' names and contents. If not set, every file `search` matches.
 * - `limit`: the most files to return. Default: 20.
 *
 * Returns `{ count, files }`. Without `text`, the files changed most recently
 * come first.
 *
 * `readDriveFile` only reads files that a search with the same `search`
 * listed. So write `search` in your code, not from text a model gave you.
 *
 * Throws `NeedsSignIn` when someone has to sign in to Google. Throws an
 * `Error` for any other problem with Google, such as a `search` that Drive
 * cannot read.
 */
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
 * Reads one file from Google Drive as text.
 *
 * A Google Doc or Slides is read as plain text, and a Google Sheet as CSV
 * (comma-separated values). Any other file is read only if it is already text,
 * such as `.txt`, `.md`, `.csv` or `.json`.
 *
 * - `search`: the same Drive search you gave `searchDriveFiles`. Default: `""`.
 * - `what`: a short name for those files, used in the error message, such as `"the reports folder"`. Required.
 * - `fileId`: the file's id, from the list `searchDriveFiles` returned. Required.
 *
 * Returns `{ id, name, kind, text, cut }`. `name` and `text` are wrapped in
 * `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers, because someone else wrote them.
 * Only the first 200,000 characters are read, and `cut` is `true` when the
 * file was longer.
 *
 * Throws if `searchDriveFiles` has not listed this file with the same `search`
 * since chloe started, or if the file is not text (such as a picture or a
 * PDF). Throws `NeedsSignIn` when someone has to sign in to Google, and an
 * `Error` for any other problem with Google.
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
