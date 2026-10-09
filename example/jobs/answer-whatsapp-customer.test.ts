// Who wrote is looked up before anything else, without a model.
import { about, is } from "@chloejs/core/test";

import { customerByPhone } from "../services/customersService.ts";

about("finding who wrote");

is("a customer is found by the number they write from", (await customerByPhone("+15550100091"))?.id, "c-91");
is("however the number is written", (await customerByPhone("+1 555 0100 091"))?.id, "c-91");
is("a number on no account finds nobody", await customerByPhone("+15559999999"), undefined);
is("and nothing finds nobody", await customerByPhone(""), undefined);
