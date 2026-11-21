// Prime's async self-wake (protocol §4.2 continue). Prime wires it in #0026.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

export interface LambdaLike {
  send(cmd: InvokeCommand): Promise<{ StatusCode?: number }>;
}

export function makeSelfWake(functionName: string, client: LambdaLike = new LambdaClient({})): (event: { reason: "continue" }) => Promise<void> {
  return async (event) => {
    const r = await client.send(
      new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(event)) }),
    );
    if (r.StatusCode !== 202) throw new Error(`self-wake of ${functionName} returned status ${r.StatusCode ?? "?"}`);
  };
}
