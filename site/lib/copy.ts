// Putting text on the clipboard, which a browser does not always allow.
// No React and no fetching.

/**
 * Copy text, and say whether it worked.
 *
 * Two things surprise people here. `navigator.clipboard` does not exist at all
 * on a page served over plain http, so on anything but https or localhost the
 * modern call is not there to make. And where it does exist the browser can
 * still refuse. Both look identical to somebody pressing the button: nothing
 * happens. So fall back to the old selection copy, which has neither limit, and
 * return false when even that did not work so the page can say so.
 */
export async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused. The old way below is still worth trying.
  }
  return bySelection(text);
}

/** Copy by selecting the text in a box nobody sees. Deprecated, and still the only thing that works everywhere. */
function bySelection(text: string): boolean {
  const selection = document.getSelection();
  const had = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  // Off screen rather than hidden: a box that is not displayed cannot be selected.
  box.style.position = "fixed";
  box.style.top = "-1000px";
  document.body.append(box);

  let done = false;
  try {
    box.select();
    done = document.execCommand("copy");
  } catch {
    done = false;
  }

  box.remove();
  // Put back whatever the person had selected before the button was pressed.
  if (had) {
    selection?.removeAllRanges();
    selection?.addRange(had);
  }
  return done;
}
