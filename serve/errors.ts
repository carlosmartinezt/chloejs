// The two refusals every route can make, in a file of their own so that the
// files doing the work can throw them without importing the router that
// catches them. http.ts re-exports both, because that is where a route author
// is already looking.

/** Nothing at that address, or nothing this caller is allowed to know is there. */
export class NotFound extends Error {}

/** The caller sent something this route cannot take. Answered 400 with the reason. */
export class BadRequest extends Error {}

/** The caller may not have this, or not now. Answered with `status` (403 unless it says) and the reason. */
export class Refused extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}
