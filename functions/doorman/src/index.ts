// Doorman Lambda entry: HTTP API (payload v2) → route().

import { depsFromEnv } from "./aws.ts";
import { route, type Deps } from "./doorman.ts";
import type { HttpEvent, HttpResponse } from "./http.ts";

let deps: Deps | null = null;

export async function handler(event: HttpEvent): Promise<HttpResponse> {
  deps ??= depsFromEnv();
  return route(deps, event);
}
