// The mark a link to another site is shown with, by its address. Marks are
// simple-icons, bundled into the page, so showing one asks nobody for anything.
import {
  siAirbnb,
  siAnthropic,
  siAsana,
  siCalendly,
  siChessdotcom,
  siClaude,
  siCloudflare,
  siConfluence,
  siDiscord,
  siDropbox,
  siFigma,
  siGithub,
  siGmail,
  siGoogle,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglemaps,
  siGooglemeet,
  siGooglesheets,
  siGoogleslides,
  siJira,
  siLichess,
  siLinear,
  siMedium,
  siNotion,
  siNpm,
  siPaypal,
  siReddit,
  siSpotify,
  siStackoverflow,
  siStripe,
  siSubstack,
  siTelegram,
  siTrello,
  siVenmo,
  siVercel,
  siWhatsapp,
  siWikipedia,
  siX,
  siYoutube,
  siZillow,
  siZoom,
} from "simple-icons";

export interface Mark {
  title: string;
  /** One SVG path on a 24 by 24 square. */
  path: string;
  hex: string;
}

/**
 * Slack's mark is not in simple-icons, at Slack's request, so it is shown as a
 * hash in Slack's colour instead of a copy of their logo.
 */
const slack: Mark = {
  title: "Slack",
  path: "M9 3 7.5 21h2.2L11.2 3H9Zm5.8 0-1.5 18h2.2L17 3h-2.2ZM3.5 8v2h17.2V8H3.5Zm-.3 6v2h17.2v-2H3.2Z",
  hex: "4A154B",
};

/** The host, and for Google the part of the address after it, each tried in order: the first that matches is the mark. */
const SITES: [RegExp, Mark][] = [
  [/^calendar\.google\.com/, siGooglecalendar],
  [/^drive\.google\.com/, siGoogledrive],
  [/^docs\.google\.com\/document/, siGoogledocs],
  [/^docs\.google\.com\/spreadsheets/, siGooglesheets],
  [/^docs\.google\.com\/presentation/, siGoogleslides],
  [/^docs\.google\.com/, siGoogledrive],
  [/^mail\.google\.com/, siGmail],
  [/^meet\.google\.com/, siGooglemeet],
  [/^(maps\.google\.com|(www\.)?google\.[a-z.]+\/maps|maps\.app\.goo\.gl)/, siGooglemaps],
  [/^([a-z]+\.)?google\.[a-z.]+(\/|$)/, siGoogle],
  [/^([a-z-]+\.)?notion\.(so|site|com)/, siNotion],
  [/^([a-z-]+\.)?slack\.com/, slack],
  [/^(gist\.)?github\.com/, siGithub],
  [/^linear\.app/, siLinear],
  [/^([a-z]+\.)?figma\.com/, siFigma],
  [/^((www|m)\.)?(youtube\.com|youtu\.be)/, siYoutube],
  [/^(t\.me|([a-z]+\.)?telegram\.org)/, siTelegram],
  [/^(wa\.me|([a-z]+\.)?whatsapp\.com)/, siWhatsapp],
  [/^(discord\.gg|([a-z]+\.)?discord\.com)/, siDiscord],
  [/^([a-z0-9-]+\.)?zoom\.us/, siZoom],
  [/^([a-z]+\.)?dropbox\.com/, siDropbox],
  [/^trello\.com/, siTrello],
  [/^app\.asana\.com|^asana\.com/, siAsana],
  [/^[a-z0-9-]+\.atlassian\.net\/wiki/, siConfluence],
  [/^[a-z0-9-]+\.atlassian\.net/, siJira],
  [/^([a-z]+\.)?vercel\.(com|app)/, siVercel],
  [/^([a-z]+\.)?cloudflare\.com/, siCloudflare],
  [/^([a-z]+\.)?stripe\.com/, siStripe],
  [/^([a-z]+\.)?airbnb\.[a-z.]+/, siAirbnb],
  [/^((www|mobile)\.)?(x|twitter)\.com/, siX],
  [/^([a-z]+\.)?reddit\.com/, siReddit],
  [/^([a-z]+\.)?wikipedia\.org/, siWikipedia],
  [/^open\.spotify\.com|^([a-z]+\.)?spotify\.com/, siSpotify],
  [/^([a-z]+\.)?paypal\.(com|me)/, siPaypal],
  [/^([a-z]+\.)?venmo\.com/, siVenmo],
  [/^([a-z]+\.)?zillow\.com/, siZillow],
  [/^([a-z]+\.)?chess\.com/, siChessdotcom],
  [/^lichess\.org/, siLichess],
  [/^claude\.ai/, siClaude],
  [/^([a-z]+\.)?anthropic\.com/, siAnthropic],
  [/^stackoverflow\.com/, siStackoverflow],
  [/^([a-z]+\.)?npmjs\.(com|org)/, siNpm],
  [/^([a-z-]+\.)?medium\.com/, siMedium],
  [/^([a-z0-9-]+\.)?substack\.com/, siSubstack],
  [/^calendly\.com/, siCalendly],
];

/** The mark for an address, or null for a site with none, which is shown with a globe. */
export function markFor(url: URL): Mark | null {
  const at = url.host.replace(/^www\./, "") + url.pathname;
  return SITES.find(([test]) => test.test(at))?.[1] ?? null;
}

/**
 * The mark's own colour, or null when that colour is too dark to read on a dark
 * page: black marks like Notion's and GitHub's then take the colour of the words.
 */
export function colourOf(mark: Mark): string | null {
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(mark.hex.slice(at, at + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.12 ? null : `#${mark.hex}`;
}
