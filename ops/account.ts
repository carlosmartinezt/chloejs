// The one password, set from a shell on the box that runs chloe.
//
//   npx chloe account     asks for a password, or makes one up if none is typed
//
// Run again later and it sets a new one, which is the way back in from a
// forgotten password. It takes a shell rather than an address, so nobody who
// only reaches the port can do it. `npx chloe setup` asks the same thing as its
// last question, so the two share one file.
import { setPassword } from "./terminal.ts";

try {
  await setPassword();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
