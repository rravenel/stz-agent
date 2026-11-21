# stz client

Thin terminal client for the Doorman API.

```sh
export STZ_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com/
export STZ_API_TOKEN=...            # read from the environment only, never a flag
node client/src/cli.ts              # or: node client/dist/cli.mjs (after scripts/build.sh)
node client/src/cli.ts --url URL --token-env MY_TOKEN_VAR
```

On start it wakes Prime and skips to the end of the event log. Each line you type is one turn: the client POSTs
it (retrying 503s with the same `msg_id`), then polls `/events` and prints each event until the turn ends
(a `model.response` with no tool call, or a model error). `/clear` is sent as text; `/quit` or Ctrl-C exits.
The token is never printed.
